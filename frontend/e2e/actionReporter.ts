import type { Reporter, TestCase, TestResult, TestStep } from '@playwright/test/reporter'

export default class ActionReporter implements Reporter {
  onTestBegin(test: TestCase): void {
    process.stdout.write(`Starting: ${test.title}\n`)
  }

  onStepBegin(_test: TestCase, _result: TestResult, step: TestStep): void {
    if (['pw:api', 'test.step', 'expect'].includes(step.category)) {
      process.stdout.write(`  ${step.title}\n`)
    }
  }
}
