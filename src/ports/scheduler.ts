// Scheduler port — Durable Object Alarms (cloud) или Node setTimeout (self_managed).
// Coordinator не знает, где он работает.

export interface SchedulerPort {
  /** Запланировать wake через atMs (UTC epoch). */
  scheduleAt(accountKey: string, atMs: number): Promise<void>
  /** Отменить pending alarm (если возможно). */
  cancel(accountKey: string): Promise<void>
}
