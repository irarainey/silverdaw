import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { generateProject } from './fixtures.ts'
import { SCENARIOS, selectScenarios } from './scenarios.ts'
import { runBenchmark } from './runner.ts'
import { compareReports } from './statistics.ts'
import { reportSchema } from './contracts.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    case: { type: 'string', multiple: true },
    output: { type: 'string' },
    corpus: { type: 'string', default: '.cache\\performance\\corpus-diverse-v2' },
    app: { type: 'string' },
    environment: { type: 'string' },
    runs: { type: 'string', default: '5' },
    frames: { type: 'string', default: '180' },
    steps: { type: 'string', default: '48' },
    'timeout-ms': { type: 'string', default: '180000' },
    'max-private-mib': { type: 'string', default: '4096' }
  }
})

const required = (value: string | undefined, flag: string): string => {
  if (!value?.trim()) throw new Error(`Missing ${flag}`)
  return value
}
const positive = (value: string, maximum: number): number => {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1 || number > maximum) {
    throw new Error(`Expected integer in 1..${maximum}, got ${value}`)
  }
  return number
}

try {
  const [command, ...files] = positionals
  if (command === 'list') {
    console.log(JSON.stringify(SCENARIOS, null, 2))
  } else if (command === 'generate') {
    const output = resolve(required(values.output, '--output (a new directory)'))
    const scenarios = selectScenarios(values.case ?? [])
    await mkdir(dirname(output), { recursive: true })
    await mkdir(output)
    for (const scenario of scenarios) {
      const manifest = await generateProject(join(output, scenario.id), scenario)
      console.log(`${scenario.id}: ${manifest.fingerprint}`)
    }
  } else if (command === 'run') {
    const [scenario] = selectScenarios(values.case ?? [])
    if ((values.case?.length ?? 0) > 1) throw new Error('Run one scenario at a time')
    await runBenchmark({
      app: required(values.app, '--app'),
      project: join(resolve(values.corpus), scenario.id),
      output: resolve(required(values.output, '--output (a new JSON file)')),
      environment: required(values.environment, '--environment (hardware/settings label)'),
      runs: positive(values.runs, 30),
      frames: positive(values.frames, 3600),
      steps: positive(values.steps, 240),
      timeoutMs: positive(values['timeout-ms'], 600000),
      maxPrivateMiB: positive(values['max-private-mib'], 32768)
    })
  } else if (command === 'compare') {
    if (files.length !== 2) throw new Error('Expected baseline.json candidate.json')
    const [before, after] = await Promise.all(
      files.map(async (file) => reportSchema.parse(JSON.parse(await readFile(file, 'utf8'))))
    )
    const result = JSON.stringify(compareReports(before, after), null, 2) + '\n'
    if (values.output) await writeFile(resolve(values.output), result, { flag: 'wx' })
    else console.log(result)
  } else {
    throw new Error('Expected generate, run, compare or list; see performance\\README.md')
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
