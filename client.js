/**
 * fish-eye · 浏览器半。
 *
 * 在设置页注册一个「陪看」分区，里面是四个滑块：抓取间隔、运动捕捉、兜底间隔、每批张数。
 * 拖动即存（防抖 600ms），写的是宿主那份参数文件 —— 抓帧脚本启动时读它当默认值。
 */
window.__ModuleLoader__.load({
  id: 'fish-eye',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    const API = '/fish-eye/api';
    const NAMES = { scan: '抓取间隔', th: '运动捕捉', forceGap: '兜底间隔', maxGrids: '每批张数' };
    const ORDER = ['scan', 'th', 'forceGap', 'maxGrids'];

    // 只用宿主的主题 token，不写死颜色 —— 换主题、切明暗都跟着走。
    const BORDER = '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))';
    const card = (extra) => ({ border: BORDER, borderRadius: '10px', padding: '12px 13px', ...extra });

    function format(key, value) {
      const number = Number(value);
      if (key === 'scan') return `${number.toFixed(1)} 秒`;
      if (key === 'th') return `${number} · ${number <= 12 ? '灵敏' : number <= 28 ? '正常' : '迟钝'}`;
      if (key === 'forceGap') return `${number} 秒`;
      return `${number} 张`;
    }

    function FishEyeSettings() {
      const [state, setState] = useState(null);
      const [message, setMessage] = useState('');
      const [error, setError] = useState('');
      const dirty = useRef(false);
      const timer = useRef(null);

      useEffect(() => {
        let cancelled = false;
        fetch(`${API}/tuning`, { headers: { accept: 'application/json' } })
          .then(async (response) => ({ ok: response.ok, body: await response.json() }))
          .then(({ ok, body }) => {
            if (cancelled) return;
            if (!ok || !body?.ok) throw new Error(body?.error || '读取失败');
            setState(body);
          })
          .catch((e) => { if (!cancelled) setError(String(e?.message ?? e)); });
        return () => { cancelled = true; };
      }, []);

      useEffect(() => {
        if (!state || !dirty.current) return undefined;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(async () => {
          try {
            const response = await fetch(`${API}/tuning`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({ tuning: state.tuning }),
            });
            const body = await response.json();
            if (!response.ok || !body?.ok) throw new Error(body?.error || `HTTP ${response.status}`);
            setMessage('已保存 · 下一批抓帧就按这个走');
            setError('');
          } catch (e) {
            setMessage('');
            setError(`保存失败：${String(e?.message ?? e)}`);
          }
        }, 600);
        return () => { if (timer.current) clearTimeout(timer.current); };
      }, [state]);

      const change = (key, value) => {
        dirty.current = true;
        setState((prev) => (prev ? { ...prev, tuning: { ...prev.tuning, [key]: value } } : prev));
      };

      if (!state) {
        return h('div', { style: { padding: '16px 2px', fontSize: '13px', opacity: 0.75 } },
          error ? `读不到陪看参数：${error}` : '读取陪看参数…');
      }

      const row = (key) => {
        const range = state.range?.[key] ?? [0, 100];
        const step = key === 'scan' ? 0.1 : 1;
        return h('div', { key, style: card({ marginTop: '10px' }) },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px' } },
            h('span', { style: { fontWeight: 500 } }, NAMES[key]),
            h('span', { style: { fontSize: '12px', opacity: 0.8 } }, format(key, state.tuning[key]))),
          h('input', {
            type: 'range',
            min: range[0], max: range[1], step,
            value: state.tuning[key],
            'aria-label': NAMES[key],
            style: { width: '100%', marginTop: '6px' },
            onChange: (e) => change(key, Number(e.target.value)),
          }),
          h('div', { style: { fontSize: '11.5px', lineHeight: 1.55, opacity: 0.6, marginTop: '2px' } },
            state.labels?.[key] ?? ''));
      };

      return h('div', { style: { maxWidth: '720px', padding: '4px 2px' } },
        h('div', { style: card() },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '陪看参数'),
          h('div', { style: { fontSize: '12px', lineHeight: 1.65, opacity: 0.75 } },
            '她看视频时抓帧的节奏。拖动就存，下一批抓帧立刻按新值走 —— 不用等她正在看片，也不用重启。',
            '播放器左侧那块面板和这里是同一份。'),
          h('div', { style: { fontSize: '11.5px', opacity: 0.55, marginTop: '4px', wordBreak: 'break-all' } },
            `文件：${state.file || '—'}`)),
        ORDER.map(row),
        h('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '12px', marginTop: '12px' } },
          h('button', {
            type: 'button',
            style: {
              padding: '6px 12px', borderRadius: '8px', border: BORDER,
              background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit', fontSize: '12.5px',
            },
            onClick: () => {
              dirty.current = true;
              setState((prev) => (prev ? { ...prev, tuning: { ...prev.defaults } } : prev));
            },
          }, '恢复默认'),
          message ? h('span', { style: { fontSize: '12px', opacity: 0.7 } }, message) : null,
          error ? h('span', { style: { fontSize: '12px', opacity: 0.85 } }, error) : null));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(
          () => ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'fish-eye',
            order: 8,
            label: () => '陪看',
          }, FishEyeSettings)),
          'fish-eye: settings section',
        );
      },
    };
  },
});
