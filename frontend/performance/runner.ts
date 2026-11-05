import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { cpus, hostname, release, totalmem, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { _electron, type ElectronApplication } from '@playwright/test'
import { findBackendPids } from '../e2e/helpers/backendProcess.ts'
import { waitForStartupReady } from '../e2e/helpers/startup.ts'
import { reportSchema, type Report } from './contracts.ts'
import { verifyProject, sha256 } from './fixtures.ts'
import { identifyBuild } from './build-identity.ts'
import { measureProject } from './measurements.ts'
import { monitorResources } from './resource-monitor.ts'

export interface RunOptions {
  app: string
  project: string
  output: string
  environment: string
  runs: number
  frames: number
  steps: number
  timeoutMs: number
  maxPrivateMiB: number
}

async function closeApp(app: ElectronApplication): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      app
        .evaluate(({ BrowserWindow }) => {
          for (const window of BrowserWindow.getAllWindows()) window.destroy()
        })
        .then(() => app.close()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Packaged app did not close within 10 seconds')),
          10000
        )
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function runBenchmark(options: RunOptions): Promise<Report> {
  const executable = resolve(options.app)
  const manifest = await verifyProject(options.project)
  const identity = await identifyBuild(executable)
  // Reserve the result before launching, never overwrite a previous baseline.
  await writeFile(options.output, JSON.stringify({ status: 'running' }) + '\n', { flag: 'wx' })
  const report: Report = {
    version: 1,
    workloadVersion: 3,
    scenario: manifest,
    build: { ...identity, runtime: {} },
    environment: {
      label: options.environment,
      host: sha256(hostname()),
      os: `${process.platform} ${release()}`,
      cpu: cpus()[0].model,
      logicalCpus: cpus().length,
      totalMemory: totalmem(),
      gpu: null,
      renderer: null
    },
    config: {
      viewport: [1440, 900],
      warmupFrames: 60,
      idleFrames: options.frames,
      wheelSteps: options.steps,
      timeoutMs: options.timeoutMs,
      maxPrivateMiB: options.maxPrivateMiB,
      resourceSampleMs: 1000,
      cacheMode: 'fresh-profile-project-os-cache-uncontrolled',
      logging: false
    },
    runs: [],
    cleanupWarnings: [],
    status: 'failed'
  }
  try {
    for (let iteration = 0; iteration < options.runs; iteration++) {
      await verifyProject(options.project)
      const root = await mkdtemp(join(tmpdir(), 'silverdaw-perf-'))
      let app: ElectronApplication | undefined
      let monitor: ReturnType<typeof monitorResources> | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let failed = false
      let phase = 'launch'
      let backendPids: number[] = []
      const lifecycle: string[] = []
      try {
        const profile = join(root, 'profile')
        const project = join(root, 'project')
        await mkdir(profile)
        // Copy only hash-covered inputs, not caches produced by another run.
        await mkdir(project)
        for (const file of manifest.files)
          await cp(join(options.project, file.path), join(project, file.path))
        await writeFile(
          join(profile, 'preferences.json'),
          JSON.stringify({ debug: { loggingEnabled: false } })
        )
        const env = Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] =>
              entry[1] !== undefined &&
              ![
                'ELECTRON_RENDERER_URL',
                'ELECTRON_RUN_AS_NODE',
                'SILVERDAW_BACKEND_CONFIG',
                'SILVERDAW_PERFORMANCE_TRACE_FILE'
              ].includes(entry[0])
          )
        )
        app = await _electron.launch({
          executablePath: executable,
          args: [`--user-data-dir=${profile}`],
          cwd: dirname(executable),
          env,
          timeout: options.timeoutMs
        })
        const ownedApp = app
        ownedApp.on('console', (message) => {
          const text = message.text()
          if (/restart requested:|exited \(generation|process error \(generation/.test(text)) {
            lifecycle.push(text)
          }
        })
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Run exceeded ${options.timeoutMs} ms`)),
            options.timeoutMs
          )
        })
        const run = async (): Promise<void> => {
          const page = await ownedApp.firstWindow()
          phase = 'startup'
          page.setDefaultTimeout(options.timeoutMs)
          const errors: string[] = []
          page.on('pageerror', (error) => errors.push(error.message))
          const bridgeReceived = { messages: 0, bytes: 0 }
          page.on('websocket', (socket) =>
            socket.on('framereceived', ({ payload }) => {
              bridgeReceived.messages++
              bridgeReceived.bytes += Buffer.byteLength(payload)
            })
          )
          await waitForStartupReady(page)
          await ownedApp.evaluate(({ BrowserWindow }, [width, height]) => {
            const window = BrowserWindow.getAllWindows()[0]
            window.unmaximize()
            window.setContentSize(width, height)
            window.focus()
          }, report.config.viewport)
          const runtime = await ownedApp.evaluate(({ app }) => ({
            packaged: app.isPackaged,
            executable: process.execPath,
            pid: process.pid,
            versions: {
              app: app.getVersion(),
              electron: process.versions.electron!,
              chrome: process.versions.chrome!,
              node: process.versions.node
            },
            pids: app.getAppMetrics().map((metric) => metric.pid)
          }))
          assert.ok(runtime.packaged, 'Benchmark requires a packaged build')
          assert.equal(resolve(runtime.executable).toLowerCase(), executable.toLowerCase())
          report.build.runtime = runtime.versions
          const gpu = await ownedApp.evaluate(({ app }) => app.getGPUInfo('basic'))
          const renderer = await page.evaluate(() => ({
            width: innerWidth,
            height: innerHeight,
            dpr: devicePixelRatio,
            screenWidth: screen.width,
            screenHeight: screen.height
          }))
          if (iteration > 0) {
            assert.deepEqual(gpu, report.environment.gpu, 'GPU settings changed within a batch')
            assert.deepEqual(
              renderer,
              report.environment.renderer,
              'Viewport changed within a batch'
            )
          }
          report.environment.gpu = gpu
          report.environment.renderer = renderer
          backendPids = findBackendPids(runtime.pid)
          assert.equal(backendPids.length, 1, 'Expected exactly one owned native backend')
          monitor = monitorResources(
            [...new Set([...runtime.pids, ...backendPids])],
            options.maxPrivateMiB,
            report.config.resourceSampleMs
          )
          await Promise.race([monitor.ready, monitor.failure])
          phase = 'project workload'
          const measurement = measureProject(
            ownedApp,
            page,
            join(project, manifest.projectFile),
            manifest,
            report.config,
            (stage) => {
              phase = stage
            }
          )
          const result = await Promise.race([measurement, monitor.failure])
          assert.deepEqual(errors, [], 'Renderer errors invalidate a measurement')
          report.runs.push({ ...result, resources: monitor.samples, bridgeReceived })
        }
        await Promise.race([run(), timeout])
      } catch (error) {
        failed = true
        report.failedAttempt = {
          directory: root,
          phase,
          backendPids,
          resources: monitor?.samples ?? [],
          lifecycle: [...lifecycle]
        }
        const page = app?.windows()[0]
        if (page) {
          try {
            await writeFile(
              join(root, 'failure-ui.txt'),
              await page.locator('body').innerText({ timeout: 2000 })
            )
            await page.screenshot({ path: join(root, 'failure.png'), timeout: 5000 })
          } catch (captureError) {
            console.warn(`Failure UI capture failed at ${root}: ${String(captureError)}`)
          }
        }
        console.error(`Benchmark evidence retained at ${root}`)
        throw error
      } finally {
        if (timer) clearTimeout(timer)
        try {
          if (monitor) await monitor.stop()
        } finally {
          try {
            if (app) await closeApp(app)
          } finally {
            if (!failed) {
              try {
                await rm(root, { recursive: true, force: true, maxRetries: 0 })
              } catch (error) {
                const message = `Temporary profile cleanup failed at ${root}: ${String(error)}`
                report.cleanupWarnings.push(message)
                console.error(message)
              }
            }
          }
        }
      }
      console.log(`${manifest.scenario.id}: ${iteration + 1}/${options.runs}`)
    }
    await verifyProject(options.project)
    assert.equal(
      (await identifyBuild(executable)).fingerprint,
      identity.fingerprint,
      'Packaged payload changed during measurement'
    )
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'
    report.error = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    await writeFile(options.output, JSON.stringify(reportSchema.parse(report), null, 2) + '\n')
  }
  return report
}
