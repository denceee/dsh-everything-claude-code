/**
 * Client half of the everything-claude-code bundle: the Settings page.
 *
 * Renders one page in Settings → Plugins, showing what this plugin actually
 * publishes — the skills it registered, the hook points it is wired to, and the
 * rules it injects at session start. Values come from the Host through a
 * same-origin route under the authenticated `/api` fence, so the page never
 * re-derives plugin state in the browser.
 *
 * Contract notes:
 *  - This file is the `id`-tagged lazy factory the browser module table loads;
 *    the id equals the package name. React comes from the host loader, so it is
 *    never bundled.
 *  - No Harness Client package is imported (a plain-JS plugin has no type check
 *    and one bad import blanks the slot). Controls are written here and styled
 *    only with `--dsw-alias-*` theme tokens.
 *  - `apply` registers through `ctx.slots.inject(...)` so unloading the bundle
 *    removes the page.
 */
window.__ModuleLoader__.load({
  id: 'dsh-everything-claude-code',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const STATUS_ROUTE = '/api/everything-claude-code/status';

    /** Bilingual text; Chinese is the default for this deployment. */
    const TEXT = {
      zh: {
        tab: 'Everything Claude Code',
        loading: '正在读取插件状态…',
        error: '读取失败',
        retry: '重试',
        skills: '个技能',
        hooks: '个钩子',
        rules: '条规则',
        prompts: '个提示词',
        personas: '个角色',
        resources: '个资源文档',
        skillsTitle: '已注册技能',
        hooksTitle: '钩子接入点',
        notesTitle: '迁移说明',
        source: '来源仓库',
        title: 'Everything Claude Code',
        intro:
          '把 everything-claude-code 适配进 DeepSeek Harness：技能经运行时注册表发布，' +
          '钩子经 dsh-hooks-claude-code 桥运行。',
        active: '生效中',
        presetHint: '在会话的 Agent 预设中选择「Everything Claude Code」即可启用该模式。',
      },
      en: {
        tab: 'Everything Claude Code',
        loading: 'Reading plugin status…',
        error: 'Could not read status',
        retry: 'Retry',
        skills: 'skills',
        hooks: 'hooks',
        rules: 'rules',
        prompts: 'prompts',
        personas: 'personas',
        resources: 'resources',
        skillsTitle: 'Registered skills',
        hooksTitle: 'Hook points',
        notesTitle: 'Migration notes',
        source: 'Source repository',
        title: 'Everything Claude Code',
        intro:
          'Adapts everything-claude-code to DeepSeek Harness: skills publish through the ' +
          'runtime registry and hooks run through the dsh-hooks-claude-code bridge.',
        active: 'active',
        presetHint: 'Pick "Everything Claude Code" as the session Agent preset to enable the mode.',
      },
    };

    /** Pick the dictionary for the active locale. Chinese is the default. */
    function dictFor(locale) {
      // `locale` arrives either as a plain tag or as the locale service; only a
      // tag beginning with "en" selects English. Anything unknown stays Chinese,
      // which is this deployment's language.
      const tag =
        typeof locale === 'string'
          ? locale
          : String(locale?.getLocale?.()?.active ?? locale?.getSnapshot?.()?.active ?? '');
      return tag.toLowerCase().startsWith('en') ? TEXT.en : TEXT.zh;
    }

    /** Read the active tag from the locale service, defensively. */
    function readLocale(localeService) {
      if (typeof localeService === 'string') return localeService;
      try {
        return (
          localeService?.getLocale?.()?.active ??
          localeService?.getSnapshot?.()?.active ??
          ''
        );
      } catch {
        return '';
      }
    }

    /**
     * Track the active locale so the page follows a language switch without a
     * reload. The section owner re-reads registration labels on locale change,
     * but the panel body is our component, so it subscribes itself.
     */
    function useActiveLocale(localeService) {
      const [active, setActive] = React.useState(() => readLocale(localeService));
      React.useEffect(() => {
        if (typeof localeService?.subscribe !== 'function') return undefined;
        const onChange = () => setActive(readLocale(localeService));
        onChange();
        return localeService.subscribe(onChange);
      }, [localeService]);
      return active;
    }

    /** Shared style objects; every color is a theme token so both themes work. */
    const S = {
      page: { padding: '20px 4px', display: 'flex', flexDirection: 'column', gap: '18px' },
      header: { display: 'flex', flexDirection: 'column', gap: '6px' },
      title: { fontSize: '15px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      subtitle: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 },
      presetHint: { fontSize: '12px', color: 'var(--dsw-alias-brand-primary)', lineHeight: 1.6 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))', gap: '10px' },
      stat: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: '8px',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
      },
      statValue: { fontSize: '22px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)', lineHeight: 1.1 },
      statLabel: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
      section: { display: 'flex', flexDirection: 'column', gap: '8px' },
      sectionTitle: { fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)', letterSpacing: '0.02em' },
      chips: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
      chip: {
        fontSize: '11px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '999px',
        padding: '3px 9px',
      },
      chipOk: { borderColor: 'var(--dsw-alias-state-success-primary)', color: 'var(--dsw-alias-state-success-primary)' },
      chipIdle: { borderColor: 'var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-secondary)' },
      list: { display: 'flex', flexDirection: 'column', gap: '6px' },
      row: {
        display: 'flex',
        alignItems: 'baseline',
        gap: '10px',
        padding: '8px 12px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '6px',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      rowName: { fontSize: '12px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)', minWidth: '150px' },
      rowNote: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 },
      button: {
        alignSelf: 'flex-start',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '6px',
        padding: '5px 12px',
        cursor: 'pointer',
      },
      error: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '11px' },
      link: { fontSize: '12px', color: 'var(--dsw-alias-brand-primary)', textDecoration: 'none' },
    };

    /** One labelled number. */
    function Stat({ value, label }) {
      return h('div', { style: S.stat }, [
        h('span', { key: 'v', style: S.statValue }, String(value ?? 0)),
        h('span', { key: 'l', style: S.statLabel }, label),
      ]);
    }

    /** The settings page. */
    function EverythingClaudeCodePage(props) {
      // The section receives the locale service as `locale`; subscribe to it so
      // the page follows a language switch in place.
      const activeLocale = useActiveLocale(props?.locale);
      const t = dictFor(activeLocale || (props?.locale ?? props?.t?.locale));
      const [state, setState] = React.useState({ phase: 'loading', data: null, message: '' });
      const [nonce, setNonce] = React.useState(0);

      React.useEffect(() => {
        const controller = new AbortController();
        let cancelled = false;
        setState({ phase: 'loading', data: null, message: '' });
        fetch(STATUS_ROUTE, { signal: controller.signal })
          .then(async (response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
          })
          .then((body) => {
            if (cancelled) return;
            if (body && body.ok === true) setState({ phase: 'ready', data: body.value, message: '' });
            else setState({ phase: 'error', data: null, message: t.error });
          })
          .catch((error) => {
            if (cancelled || error?.name === 'AbortError') return;
            setState({ phase: 'error', data: null, message: String(error?.message ?? error) });
          });
        return () => {
          cancelled = true;
          controller.abort();
        };
      }, [nonce, t.error]);

      if (state.phase === 'loading') {
        return h('div', { style: S.page }, h('div', { style: S.subtitle }, t.loading));
      }

      if (state.phase === 'error') {
        return h('div', { style: S.page }, [
          h('div', { key: 'e', style: S.error }, `${t.error}: ${state.message}`),
          h(
            'button',
            { key: 'b', type: 'button', style: S.button, onClick: () => setNonce((n) => n + 1) },
            t.retry,
          ),
        ]);
      }

      const d = state.data ?? {};
      const skills = Array.isArray(d.skills) ? d.skills : [];
      const hooks = Array.isArray(d.hooks) ? d.hooks : [];
      const notes = Array.isArray(d.notes) ? d.notes : [];

      return h('div', { style: S.page }, [
        h('div', { key: 'head', style: S.header }, [
          h('div', { key: 't', style: S.title }, t.title),
          h('div', { key: 's', style: S.subtitle }, t.intro),
          // The preset is what makes this an agent "mode"; name it here so the
          // page says how to switch it on rather than only what exists.
          h('div', { key: 'p', style: S.presetHint }, t.presetHint),
        ]),

        h('div', { key: 'grid', style: S.grid }, [
          h(Stat, { key: 'sk', value: skills.length, label: t.skills }),
          h(Stat, { key: 'hk', value: hooks.length, label: t.hooks }),
          h(Stat, { key: 'ru', value: d.counts?.rules, label: t.rules }),
          h(Stat, { key: 'pr', value: d.counts?.prompts, label: t.prompts }),
          h(Stat, { key: 'pe', value: d.counts?.personas, label: t.personas }),
          h(Stat, { key: 're', value: d.counts?.resources, label: t.resources }),
        ]),

        h('div', { key: 'skills', style: S.section }, [
          h('div', { key: 'h', style: S.sectionTitle }, t.skillsTitle),
          h(
            'div',
            { key: 'c', style: S.chips },
            skills.map((name) => h('span', { key: name, style: S.chip }, name)),
          ),
        ]),

        h('div', { key: 'hooks', style: S.section }, [
          h('div', { key: 'h', style: S.sectionTitle }, t.hooksTitle),
          h(
            'div',
            { key: 'l', style: S.list },
            hooks.map((hook) =>
              h('div', { key: `${hook.event}-${hook.matcher}`, style: S.row }, [
                h('span', { key: 'e', style: S.rowName }, hook.event),
                h('span', { key: 'm', style: { ...S.chip, ...(hook.active ? S.chipOk : S.chipIdle) } }, hook.matcher),
                h('span', { key: 'n', style: S.rowNote }, String(hook.note ?? '')),
              ]),
            ),
          ),
        ]),

        notes.length > 0
          ? h('div', { key: 'notes', style: S.section }, [
              h('div', { key: 'h', style: S.sectionTitle }, t.notesTitle),
              h(
                'div',
                { key: 'l', style: S.list },
                notes.map((note, index) =>
                  h('div', { key: index, style: S.row }, [
                    h('span', { key: 'n', style: S.rowNote }, String(note)),
                  ]),
                ),
              ),
            ])
          : null,

        h('div', { key: 'src', style: S.section }, [
          h('div', { key: 'h', style: S.sectionTitle }, t.source),
          h(
            'a',
            { key: 'a', style: S.link, href: String(d.repository ?? '#'), target: '_blank', rel: 'noreferrer' },
            String(d.repository ?? ''),
          ),
        ]),
      ]);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Register a TOP-LEVEL settings page, not a tab inside "Built-in
        // plugins". That section is the read-only inventory of what the
        // deployment ships ("Inspect the plugins this deployment ships"), so a
        // third-party plugin's own page does not belong inside it — the sibling
        // third-party plugins register here instead.
        //
        // `label` is re-read on every projection, so it stays a thunk and the
        // nav row follows a locale change without re-registering.
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'everything-claude-code',
              order: 19,
              label: () => {
                const locale = ctx.get?.('locale')?.getLocale?.()?.active;
                return dictFor(locale).tab;
              },
            },
            EverythingClaudeCodePage,
          ),
        );
      },
    };
  },
});
