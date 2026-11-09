import { EventEmitter } from 'node:events';

/** Events emitted by the workflow, task and AI layers; consumed by the CLI and loggers. */
export type RecodeEvent =
  | { type: 'step-started'; step: string; binaryId: string }
  | { type: 'step-completed'; step: string; binaryId: string; skipped: boolean }
  | { type: 'step-failed'; step: string; binaryId: string; message: string }
  | { type: 'info'; message: string }
  | { type: 'warning'; message: string }
  | { type: 'task-started'; taskId: string; label: string }
  | { type: 'task-completed'; taskId: string; label: string }
  | { type: 'task-failed'; taskId: string; label: string; message: string }
  | { type: 'agent-activity'; session: string; agent: string; summary: string };

export type RecodeEventListener = (event: RecodeEvent) => void;

/** Minimal typed event bus. */
export class EventBus {
  private readonly emitter = new EventEmitter();

  emit(event: RecodeEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(listener: RecodeEventListener): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}
