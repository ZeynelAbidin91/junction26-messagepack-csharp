// How each recorded hand-off of the MessagePack pipeline is shown in a trace table.
// Each cell returns { key, show }: `key` decides whether before and after differ, `show` is the Markdown.

export function handoffs({ code }) {
  const buildFails = (s) => [...s.generatorDiagnostics, ...s.analyzerDiagnostics].some((d) => d.severity === 'Error');
  const esc = (t) => String(t).replace(/</g, '&lt;');

  const runtimeCell = (s, name) => {
    if (!s.runtime) return { key: 'none', show: 'not recorded' };
    if (s.runtime.error) return { key: 'rterr:' + s.runtime.error, show: `the scenario itself threw: ${code(s.runtime.error)}` };
    if (!s.runtime.built) return { key: 'nobuild', show: 'did not compile' };
    const cfg = s.runtime.configs?.find((c) => c.name === name);
    if (!cfg) return { key: 'none', show: 'no generated resolver exists to use' };
    const note = buildFails(s) ? '<br><sub>the build fails first, so this cannot ship</sub>' : '';
    if (cfg.error) {
      const [type, ...rest] = cfg.error.split(': ');
      const msg = esc(rest.join(': ').replace(/ type:.* member:/, ' Member: '));
      return { key: 'err:' + cfg.error, show: `throws ${code(type)}<br>${msg}${note}` };
    }
    const intact = cfg.valuesOut === s.runtime.valuesIn;
    return {
      key: `ok:${cfg.wire}:${cfg.valuesOut}`,
      show: `in ${code(s.runtime.valuesIn)}<br>wire ${code(cfg.wire)} (${cfg.byteCount} bytes)<br>out ${code(cfg.valuesOut)}<br>${intact ? 'round trip intact' : '⚠️ **a value changed on the way**'}${note}`,
    };
  };

  const list = [
    {
      id: 'model',
      label: '① Model out of TypeCollector',
      cell: (s) => {
        const ex = s.model.find((m) => m.exception);
        if (ex) return { key: 'ex:' + ex.exception, show: `throws ${code(ex.exception)}` };
        const types = new Map();
        for (const m of s.model) for (const o of m.objects ?? []) types.set(o.type, o.members);
        const lines = [...types].map(([t, members]) => `${code(t)}: ${esc(members.join(', ')) || 'no members'}`);
        return { key: JSON.stringify([...types]), show: lines.join('<br>') || 'no types collected' };
      },
    },
    {
      id: 'diagnostics',
      label: '② Diagnostics out',
      cell: (s) => {
        const groups = new Map();
        for (const d of [...s.generatorDiagnostics, ...s.analyzerDiagnostics]) {
          const k = `${d.severity.toLowerCase()} ${code(d.id)}${d.location === '(none)' ? '' : ` at ${d.location}`}`;
          groups.set(k, (groups.get(k) ?? 0) + 1);
        }
        const items = [...groups].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k));
        const verdict = buildFails(s) ? '**build fails**' : items.length ? 'build passes with warnings' : 'build passes';
        return { key: JSON.stringify([...groups]), show: `${items.join('<br>') || 'none'}<br>${verdict}` };
      },
    },
    {
      id: 'generated',
      label: '③ C# files out of the templates',
      cell: (s) => {
        const names = s.generated.map((g) => g.hintName.replace(/^Formatters\./, '').replace(/\.g\.cs$/, '').replace(/`\d+/, '').split('.').pop());
        return {
          key: JSON.stringify(s.generated.map((g) => [g.hintName, g.text])),
          show: names.length ? `${names.length} files: ${names.map(code).join(', ')}` : '0 files',
        };
      },
    },
    { id: 'rtDefault', label: '④ Run time, default options', cell: (s) => runtimeCell(s, 'default options') },
    { id: 'rtGenerated', label: '④ Run time, generated resolver first', cell: (s) => runtimeCell(s, 'generated resolver first') },
  ];

  // A scenario the probe could not run shows the reason in every row instead of crashing the table.
  return list.map((h) => ({
    ...h,
    cell: (s) => {
      if (!s) return { key: 'missing', show: 'not run on this side' };
      if (s.probeError) return { key: 'probe:' + s.probeError, show: `probe could not run this case: ${esc(s.probeError)}` };
      if (s.sourceErrors?.length && h.id !== 'diagnostics') {
        return { key: 'src:' + s.sourceErrors[0], show: `the scenario's own C# does not compile: ${code(s.sourceErrors[0].slice(0, 160))}` };
      }
      return h.cell(s);
    },
  }));
}

// Compact, model-readable digest of one probe side, for the reviewing agent.
export function digest(s) {
  if (!s) return null;
  if (s.probeError) return { probeError: s.probeError };
  return {
    model: s.model,
    generatorException: s.generatorException,
    diagnostics: [...s.generatorDiagnostics, ...s.analyzerDiagnostics].map((d) => `${d.severity} ${d.id} @${d.location}: ${d.message}`),
    sourceErrors: s.sourceErrors,
    generatedFiles: s.generated.map((g) => g.hintName),
    runtime: s.runtime,
  };
}
