// Durable Object для ShopCoordinator.
// Этот файл НЕ тестируется в vitest (DO нужен Workers runtime).
// Сборка через `wrangler deploy` подключит реальный cloudflare:workers-types.
//
// Поведение:
// - ID = hash(wb_account_key) — один DO на аккаунт WB
// - blockConcurrencyWhile гарантирует, что только один tick в момент времени
// - alarm() вызывается через Storage API, а не setTimeout
// - tick() делает одну WB-операцию, затем ставит alarm на следующий слот

// В production-версии (wrangler deploy) этот класс наследует DurableObject:
// import { DurableObject } from 'cloudflare:workers-types'
// export class ShopCoordinatorDO extends DurableObject<Env> { ... }

import { tick, type CoordinatorEnv, type TickResult } from '../../coordinator/shop-coordinator.js'

interface DOState {
  lastTickAtMs: number
  lastResult: TickResult | null
  nextAlarmAtMs: number | null
}

/** Stub-класс. В production будет extends DurableObject<Env>. */
export class ShopCoordinatorDO {
  private state: DOState = {
    lastTickAtMs: 0,
    lastResult: null,
    nextAlarmAtMs: null,
  }

  /** RPC: ручной kick. */
  async kick(shopId: string, env: CoordinatorEnv): Promise<TickResult> {
    const now = Date.now()
    const result = await tick(env, shopId, now)
    this.state.lastTickAtMs = now
    this.state.lastResult = result
    return result
  }

  /** RPC: текущее состояние. */
  async status(): Promise<DOState> {
    return this.state
  }
}
