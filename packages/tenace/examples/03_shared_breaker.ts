/**
 * One circuit breaker and one bulkhead shared by several policies of the same dependency.
 * Run: node --conditions=tenace-source --import=@poppinss/ts-exec examples/03_shared_breaker.ts
 */
import { Bulkhead, CircuitBreaker, Tenace } from '@julr/tenace'

const breaker = new CircuitBreaker({
  name: 'payments-api',
  trip: { rate: 0.5, calls: 4 },
  openFor: '30s',
  onStateChange: ({ from, to }) => console.log(`circuit ${from} -> ${to}`),
})
const bulkhead = new Bulkhead({ name: 'payments-api', concurrency: 10, queue: 50 })

// shared building block: every policy using it shares the circuit and the slots
const paymentsApi = Tenace.policy().withTimeout('2s').with(breaker).with(bulkhead)

const charge = Tenace.policy()
  .with(paymentsApi)
  .withFallbackOn(['CircuitOpenError'], () => 'queued for later')
const refund = Tenace.policy().with(paymentsApi).withRetry({ retries: 2, delay: 100 })

const down = async () => {
  throw new Error('503')
}
for (let i = 0; i < 4; i++) await refund.settle(down, { idempotent: false })

console.log('breaker:', breaker.state)
console.log('charge:', await charge.execute(() => 'charged'))
console.log('describe:', charge.describe())
