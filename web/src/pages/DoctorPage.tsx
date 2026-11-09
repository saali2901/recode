import { api } from '../api';
import { ErrorAlert, StatusTag } from '../components/common';
import { useResource } from '../hooks';
import type { DoctorCheck } from '../types';

export function DoctorPage() {
  const result = useResource(() => api.get<{ checks: DoctorCheck[] }>('/api/doctor'), 'doctor');
  const checks = result.data?.checks ?? [];
  const failed = checks.filter((c) => c.status === 'fail').length;
  return (
    <div className="stack gap-6">
      <div className="cluster cluster--between">
        <h1>Doctor</h1>
        <button className="btn" type="button" onClick={result.reload} disabled={result.loading}>
          {result.loading ? 'Checking…' : 'Check again'}
        </button>
      </div>
      <p className="text-muted">
        Each workflow step needs different tools: <strong>Analyze</strong> needs Ghidra and Java,{' '}
        <strong>Reconstruct</strong> needs Claude Code with a login, <strong>Build</strong> needs a
        C compiler, CMake and Ninja.
      </p>
      {result.error && <ErrorAlert error={result.error} />}
      {result.data && failed === 0 && (
        <div className="alert alert--success" role="status">
          <div className="alert__content">
            <p className="alert__title">Everything required is available</p>
          </div>
        </div>
      )}
      {checks.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tool</th>
                <th>Status</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {checks.map((check) => (
                <tr key={check.id}>
                  <td>{check.label}</td>
                  <td>
                    <StatusTag status={check.status} />
                  </td>
                  <td>
                    <div>{check.detail}</div>
                    {check.status !== 'ok' && check.hint && (
                      <div className="text-sm text-muted">{check.hint}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-sm text-muted">
        Tool locations can be set in <a href="#/settings">Settings</a> (for example{' '}
        <code>tools.ghidraInstallDir</code>).
      </p>
    </div>
  );
}
