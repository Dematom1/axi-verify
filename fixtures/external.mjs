#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';
const bin = basename(process.argv[1]);
const args = process.argv.slice(2), text = args.join(' ');
let value;
if (bin === 'argocd') {
  if (text.startsWith('context')) value = 'CURRENT  NAME   SERVER\n*        probe  probe.invalid\n';
  else if (text.startsWith('account get-user-info')) value = { loggedIn: true, username: 'fixture', groups: [] };
  else if (text.startsWith('version')) value = { client: { version: 'v3.0.0' }, server: { version: 'v3.0.0' } };
  else if (JSON.stringify(args) === JSON.stringify(['app', 'list', '-o', 'json'])) value = ['healthy', 'problem'].map((name, index) => ({
    metadata: { name, namespace: 'default' }, spec: { project: 'probe', source: { repoURL: 'https://example.invalid/repo' } },
    status: { sync: { status: index ? 'OutOfSync' : 'Synced' }, health: { status: index ? 'Degraded' : 'Healthy', message: index ? 'synthetic readiness failure' : '' }, resources: [] },
  }));
} else if (bin === 'argo') {
  if (text.startsWith('version')) value = 'argo: v3.6.0\n';
  else if (text.startsWith('list')) value = ['healthy', 'problem'].map((name, index) => ({
    metadata: { name, namespace: 'default', creationTimestamp: '2026-01-01T00:00:00Z' },
    spec: {}, status: { phase: index ? 'Failed' : 'Succeeded', message: index ? 'synthetic step failure' : '' },
  }));
} else if (bin === 'kubectl') {
  if (text.includes('current-context') || text.startsWith('config get-contexts')) value = 'probe\n';
  else if (text.startsWith('config view') && text.includes('cluster.server')) value = 'https://probe.invalid\ndefault\n';
  else if (text.startsWith('config view') && text.includes('jsonpath')) value = 'default\n';
  else if (text.startsWith('config view')) value = { 'current-context': 'probe', contexts: [{ name: 'probe', context: { namespace: 'default', cluster: 'probe' } }], clusters: [{ name: 'probe', cluster: { server: 'https://probe.invalid' } }] };
  else if (text.startsWith('version')) value = { clientVersion: { gitVersion: 'v1.34.0' } };
  else if (/\bget namespace default\b/.test(text)) value = 'namespace/default\n';
  else if (/\bget pods\b/.test(text)) value = { apiVersion: 'v1', kind: 'PodList', items: ['healthy', 'problem'].map((name, index) => ({
    metadata: { name, namespace: 'default', creationTimestamp: '2026-01-01T00:00:00Z' },
    spec: { containers: [{ name: 'app', image: 'example.invalid/app:fixture' }] },
    status: { phase: index ? 'Pending' : 'Running', conditions: [{ type: 'Ready', status: index ? 'False' : 'True' }], containerStatuses: [{ name: 'app', ready: !index, restartCount: index ? 3 : 0, state: index ? { waiting: { reason: 'CrashLoopBackOff' } } : { running: {} } }] },
  })) };
} else if (['terraform', 'tofu'].includes(bin)) {
  if (text.includes('version -json')) value = { terraform_version: '1.10.0' };
  else if (text.includes('state list')) value = 'terraform_data.healthy\nterraform_data.problem\n';
  else if (text.includes('show -json')) value = { format_version: '1.0', values: { root_module: { resources: ['healthy', 'problem'].map(name => ({ address: `terraform_data.${name}`, mode: 'managed', type: 'terraform_data', name, values: { input: 'fixture' }, sensitive_values: {} })) } } };
}
const allowed = value !== undefined;
appendFileSync(process.env.AXI_FIXTURE_LOG, JSON.stringify({ bin, args, allowed }) + '\n');
if (!allowed) { process.stderr.write('Unexpected fixture subprocess: ' + bin + ' ' + text + '\n'); process.exit(97); }
process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
