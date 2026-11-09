import type { Command } from 'commander';
import { TaskStore } from '../../core/tasks/task-store.js';
import { STEP_ORDER, WorkflowManager } from '../../core/workflow/workflow.js';
import type { Runtime } from '../runtime.js';

export function registerStatus(program: Command, runtime: Runtime): void {
  program
    .command('status')
    .description('Show project contents, workflow steps and reconstruction progress')
    .option('--binary <id>', 'only this binary')
    .option('--json', 'machine-readable output')
    .action(async (options: { binary?: string; json?: boolean }) => {
      const { project, events } = await runtime.context();
      const binaries = options.binary ? [project.resolveBinary(options.binary)] : project.binaries;

      const data = [];
      for (const binary of binaries) {
        const workflow = await new WorkflowManager(
          project.workflowFile(binary.id),
          binary.id,
          events,
        ).load();
        const store = new TaskStore(project.tasksFile(binary.id));
        const hasTasks = (await store.load()) !== undefined;
        data.push({
          id: binary.id,
          format: binary.metadata.format,
          architecture: binary.metadata.architecture,
          steps: Object.fromEntries(STEP_ORDER.map((s) => [s, workflow.steps[s]])),
          tasks: hasTasks ? store.counts() : undefined,
        });
      }
      if (options.json) {
        runtime.out.json({
          project: project.name,
          binaries: data,
          references: project.references.length,
        });
        return;
      }

      const out = runtime.out;
      out.line(`Project: ${project.name}  (${project.root})`);
      out.line(
        `Binaries: ${project.binaries.length}, reference files: ${project.references.length}`,
      );
      for (const item of data) {
        out.line();
        out.line(`${item.id}  [${item.format}, ${item.architecture}]`);
        out.table(
          STEP_ORDER.map((step) => {
            const s = item.steps[step];
            return [
              step,
              s?.status ?? 'pending',
              String(s?.attempts ?? 0),
              s?.summary ?? s?.error ?? '',
            ];
          }),
          ['Step', 'Status', 'Attempts', 'Result'],
        );
        if (item.tasks) {
          const t = item.tasks;
          out.line(
            `Tasks: ${t.completed} completed, ${t.pending} pending, ${t.running} running, ${t.failed} failed`,
          );
        }
      }
      if (project.binaries.length === 0) out.hint('No binaries yet. Run: recode import <file>');
    });
}
