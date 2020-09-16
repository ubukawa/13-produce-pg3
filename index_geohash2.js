// libraries
const config = require('config')
const { spawn } = require('child_process')
const byline = require('byline')
const fs = require('fs')
const Queue = require('better-queue')
const pretty = require('prettysize')
const tilebelt = require('@mapbox/tilebelt')
const TimeFormat = require('hh-mm-ss')
const { Pool, Query } = require('pg')
const Spinner = require('cli-spinner').Spinner
const winston = require('winston')
const DailyRotateFile = require('winston-daily-rotate-file')
const modify = require('./modify.js')

// config constants
const host = config.get('host')
const port = config.get('port') 
const unixUser = config.get('unixUser')
const wtpsThreshold = config.get('wtpsThreshold')
const monitorPeriod = config.get('monitorPeriod')
const Z = config.get('Z')
const dbUser = config.get('dbUser')
const dbPassword = config.get('dbPassword')
const relations = config.get('relations')
const defaultDate = new Date(config.get('defaultDate'))
const mbtilesDir = config.get('mbtilesDir')
const propertyBlacklist = config.get('propertyBlacklist')
const spinnerString = config.get('spinnerString')
const fetchSize = config.get('fetchSize')

// global configurations
Spinner.setDefaultSpinnerString(spinnerString)
winston.configure({
  level: 'silly',
  format: winston.format.simple(),
  transports: [ 
    new DailyRotateFile({
      filename: '13-produce-pg3%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d'
    }),
  ]
})

// global variable
let idle = true
let wtps
let modules = {}
let sar
let pools = {}
let productionSpinner = new Spinner()
let moduleKeysInProgress = []

//// start the monitor //(note: edited here)
//sar = spawn('ssh', [
//  '-l', unixUser,
//  host, `sar -b ${monitorPeriod}`
//], { stdio: ['inherit', 'pipe', 'pipe'] })
//byline(sar.stdout).on('data', line => {
//  wtps =
//    line.toString().split(/\s+/).map(v => Number(v))[4]
//  if (Number.isNaN(wtps)) return
//  idle = wtps < wtpsThreshold
//})
const isIdle = () => {
  return idle
}

////This checkExpiretiles needs to be confirmed
//const checkExpiretiles = (date) => {
//  return new Promise((resolve, reject) => {
//    const dateKey = date.toISOString().split('T')[0].replace(/-/g, '')
//    const cat = spawn('ssh', [
//      '-l', unixUser,
//      host, `cat /osm_base/expiretiles/${dateKey}/` + '*'
//    ], { stdio: ['inherit', 'pipe', 'ignore'] })
//    byline(cat.stdout).on('data', line => {
//      let zxy = line.toString().split('/').map(v => Number(v))
//      let Zxy = [6, zxy[1] >> (zxy[0] - Z), zxy[2] >> (zxy[0] - Z)]
//      let moduleKey = Zxy.join('-')
//      if (modules.hasOwnProperty(moduleKey) && modules[moduleKey].mtime <= date) {
//        modules[moduleKey].score += // 'Africa premium'
//          (Zxy[1] >= 27 && Zxy[1] <= 42 && Zxy[2] >= 24 && Zxy[2] <= 38) ? 10 : 1
//      }
//    })
//    cat.on('exit', () => {
//      resolve()
//    })
//  })
//}

const getScores = async () => {
  return new Promise(async (resolve, reject) => {
    // identify modules to update
    let oldestDate = new Date()
    for (let x = 0; x < 2 ** Z; x++) {
      for (let y = 0; y < 2 ** Z; y++) {
        const moduleKey = `${Z}-${x}-${y}`
        const path = `${mbtilesDir}/${moduleKey}.mbtiles`
        let mtime = defaultDate
        let size = 0
        if (fs.existsSync(path)) {
          let stat = fs.statSync(path)
          mtime = stat.mtime
          size = stat.size
        }
        oldestDate = (oldestDate < mtime) ? oldestDate : mtime
        modules[`${Z}-${x}-${y}`] = {
          mtime: mtime,
          size: size,
         score: 0
       }
      }
    }

    oldestDate.setUTCHours(0)
    oldestDate.setUTCMinutes(0)
    oldestDate.setUTCSeconds(0)
    oldestDate.setUTCMilliseconds(0)

    const now = new Date()
    for (let date = oldestDate; date < now; date.setDate(date.getDate() + 1)) {
      const spinner = new Spinner(`scoring modules by ${date.toISOString().split('T')[0]}`)
      spinner.start()
//      await checkExpiretiles(date)
      spinner.stop()
      process.stdout.write('\n')
    }
    resolve()
  })
}

const iso = () => {
  return (new Date()).toISOString()
}

const noPressureWrite = (downstream, f) => {
  return new Promise((res) => {
    if (downstream.write(`\x1e${JSON.stringify(f)}\n`)) {
      res()
    } else {
      downstream.once('drain', () => { 
        res()
      })
    }
  })
}

const fetch = (client, database, table, downstream) => {
  return new Promise((resolve, reject) => {
    let count = 0
    let features = []
    client.query(new Query(`FETCH ${fetchSize} FROM cur`))
    .on('row', row => {
      let f = {
        type: 'Feature',
        properties: row,
        geometry: JSON.parse(row.st_asgeojson)
      }
      delete f.properties.st_asgeojson
      f.properties._database = database
      f.properties._table = table
      count++
      f = modify(f)
      if (f) features.push(f)
    })
    .on('error', err => {
      console.error(err.stack)
      reject()
    })
    .on('end', async () => {
      for (f of features) {
        try {
          await noPressureWrite(downstream, f)
        } catch (e) {
          reject(e)
        }
      }
      resolve(count)
    })
  })
}

const dumpAndModify = async (bbox, relation, downstream, moduleKey) => {
  return new Promise((resolve, reject) => {
    const startTime = new Date()
    const [database, schema, table] = relation.split('::')
    if (!pools[database]) {
      pools[database] = new Pool({
        host: host,
        user: dbUser,
        port: port,
        password: dbPassword,
        database: database
      })
    }
    pools[database].connect(async (err, client, release) => {
      if (err) throw err
      let sql = `
SELECT column_name FROM information_schema.columns 
  WHERE table_name='${schema}.${table}' ORDER BY ordinal_position`
      let cols = await client.query(sql)
      cols = cols.rows.map(r => r.column_name).filter(r => r !== 'geom')
      cols = cols.filter(v => !propertyBlacklist.includes(v))
      // ST_AsGeoJSON(ST_Intersection(ST_MakeValid(${table}.geom), envelope.geom))
      cols.push(`ST_AsGeoJSON(${schema}.${table}.geom)`)
      await client.query(`BEGIN`)
      sql = `
WITH 
  envelope AS (SELECT ST_MakeEnvelope(${bbox.join(', ')}, 4326) AS geom)
SELECT 
  ${cols.toString()}
FROM ${schema}.${table}
JOIN envelope ON ${schema}.${table}.geom && envelope.geom
WHERE ST_GeoHash(${schema}.${table}.geom,2) = ST_GeoHash(envelope.geom,2)
` 
      cols = await client.query(sql)
      try {
        while (await fetch(client, database, table, downstream) !== 0) {}
      } catch (e) {
        reject(e)
      }
      await client.query(`COMMIT`)
      winston.info(`${iso()}: finished ${relation} of ${moduleKey}`)
      release()
      resolve()
    })
  })
}

const sleep = (wait) => {
  return new Promise((resolve, reject) => {
    setTimeout(() => { resolve() }, wait)
  })
}

const queue = new Queue(async (t, cb) => {
  const startTime = new Date()
  const moduleKey = t.moduleKey
  const queueStats = queue.getStats()
  const [z, x, y] = moduleKey.split('-').map(v => Number(v))
  const bbox = tilebelt.tileToBBOX([x, y, z])
  const tmpPath = `${mbtilesDir}/part-${moduleKey}.mbtiles`
  const dstPath = `${mbtilesDir}/${moduleKey}.mbtiles`

/// TEMP
//if (fs.existsSync(dstPath)) return cb()

  // console.log(`[${queueStats.total + 1}/${queueStats.peak}] process ${moduleKey} (score: ${modules[moduleKey].score}, previous size: ${pretty(modules[moduleKey].size)})`)
  moduleKeysInProgress.push(moduleKey)
  productionSpinner.setSpinnerTitle(moduleKeysInProgress.join(', '))

  const tippecanoe = spawn('tippecanoe', [
    '--quiet',
    '--no-feature-limit',
    '--no-tile-size-limit',
    '--force',
    '--simplification=2',
    `--minimum-zoom=${Z}`,
    '--maximum-zoom=15',
    '--base-zoom=15',
    '--hilbert',
    `--clip-bounding-box=${bbox.join(',')}`,
    `--output=${tmpPath}`
  ], { stdio: ['pipe', 'inherit', 'inherit'] })
  tippecanoe.on('exit', () => {
    fs.renameSync(tmpPath, dstPath)
    moduleKeysInProgress = moduleKeysInProgress.filter((v) => !(v === moduleKey))
    productionSpinner.stop()
    process.stdout.write('\n')
    const logString = `${iso()}: [${queueStats.total + 1}/${queueStats.peak}] process ${moduleKey} (score: ${modules[moduleKey].score}, ${pretty(modules[moduleKey].size)} => ${pretty(fs.statSync(dstPath).size)}) took ${TimeFormat.fromMs(new Date() - startTime)} wtps=${wtps}.`
    winston.info(logString)
    console.log(logString)
    if (moduleKeysInProgress.length !== 0) {
      productionSpinner.setSpinnerTitle(moduleKeysInProgress.join(', '))
      productionSpinner.start()
    }
    return cb()
  })

  productionSpinner.start()
  for (relation of relations) {
    while (!isIdle()) {
      winston.info(`${iso()}: short break due to heavy disk writes (wtps=${wtps}).`)
      await sleep(5000)
    }
    try {
      await dumpAndModify(bbox, relation, tippecanoe.stdin, moduleKey)
    } catch (e) {
      winston.error(e)
      cb(true)
    }
  }
  tippecanoe.stdin.end()
}, { 
  concurrent: config.get('concurrent'), 
  maxRetries: config.get('maxRetries'),
  retryDelay: config.get('retryDelay') 
})

const queueTasks = () => {
  let moduleKeys = Object.keys(modules)
  moduleKeys.sort((a, b) => modules[b].score - modules[a].score)
//  for (let moduleKey of moduleKeys) {
  for (let moduleKey of ['6-34-30','6-34-31','6-34-32','6-34-33','6-35-30','6-35-31','6-35-32','6-35-33', '6-36-30','6-36-31','6-36-32','6-36-33', '6-37-30', '6-37-31', '6-37-32', '6-37-33', '6-38-30', '6-38-31', '6-38-32', '6-38-33']) { //// TEMP
    //if (modules[moduleKey].score > 0) {
      queue.push({
        moduleKey: moduleKey
      })
    //}
  }
}

// shutdown this system
const shutdown = () => {
  winston.info(`${iso()}: production system shutdown.`)
  console.log('** production system shutdown! **')
//  sar.kill()
}

const main = async () => {
  winston.info(`${iso()}: prototype11 production started.`)
  await getScores()
  queueTasks()
  queue.on('drain', () => {
    shutdown()
  })
}

main()
