import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireThat } from './contracts.mjs';
import { regularBytes, verifyBundle, artifactName } from './evidence.mjs';
import { verifyBaseline, baselineArtifactName } from './baseline-evidence.mjs';

// archive:false uses the actual basename, ignoring upload-artifact's name input.
// Scope filenames by the complete artifact identity to avoid matrix collisions.
export function presentationName(bundleName, role) {
  requireThat(typeof bundleName === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,220}$/.test(bundleName), 'Invalid presentation identity');
  requireThat(['report', 'compare'].includes(role), 'Invalid presentation role');
  return `${bundleName.replace(/-comparison$/, '')}-${role}.html`;
}

export function stagePresentations({ bundle, output }) {
  const capture = JSON.parse(regularBytes(bundle, 'capture.json'));
  if (capture.status !== 'captured') return {};
  const manifest = JSON.parse(regularBytes(bundle, 'manifest.json'));
  const baseline = manifest.schemaVersion === 'pulse.report-action.baseline.v1';
  (baseline ? verifyBaseline : verifyBundle)(bundle, manifest);
  requireThat(capture.artifactName === (baseline ? baselineArtifactName : artifactName)(manifest), 'Presentation bundle identity differs');
  const role = capture.comparison ? 'compare' : 'report';
  const file = manifest.files.find(f => f.role === (role === 'report' ? 'head-html' : 'compare-html'));
  if (!file) return {}; // An unavailable baseline has no comparison HTML.
  const root = resolve(output);
  requireThat(!/[\r\n]/.test(root), 'Invalid presentation output path');
  mkdirSync(root);
  const path = join(root, presentationName(capture.artifactName, role));
  writeFileSync(path, regularBytes(bundle, file.path), { flag: 'wx' });
  return { [role]: path };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = stagePresentations({ bundle: process.env.REPORT_BUNDLE, output: process.env.REPORT_PRESENTATIONS });
  for (const [role, path] of Object.entries(result)) {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${role}_path=${path}\n`);
  }
}
