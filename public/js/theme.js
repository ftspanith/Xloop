/**
 * XLOOP Theme System
 * 6 premium themes, persisted in localStorage, applied via CSS custom properties
 */
(function () {
  'use strict';

  // ── Theme definitions ────────────────────────────────────────────────────────
  const THEMES = {
    dark: {
      label: 'Midnight',
      icon: '🌑',
      preview: ['#000000', '#E50914', '#141414'],
      vars: {
        '--bg':      '#000000',
        '--bg2':     '#141414',
        '--bg3':     '#1F1F1F',
        '--card':    '#181818',
        '--card-h':  '#2A2A2A',
        '--border':  'rgba(255,255,255,0.1)',
        '--accent':  '#E50914',
        '--accent2': '#B81D24',
        '--glow':    'rgba(229,9,20,0.25)',
        '--text':    '#FFFFFF',
        '--text2':   '#A3A3A3',
        '--text3':   '#737373',
      }
    },
    amoled: {
      label: 'AMOLED',
      icon: '⬛',
      preview: ['#000000', '#FF0033', '#050505'],
      vars: {
        '--bg':      '#000000',
        '--bg2':     '#050505',
        '--bg3':     '#0A0A0A',
        '--card':    '#080808',
        '--card-h':  '#111111',
        '--border':  'rgba(255,255,255,0.06)',
        '--accent':  '#FF0033',
        '--accent2': '#CC0029',
        '--glow':    'rgba(255,0,51,0.3)',
        '--text':    '#FFFFFF',
        '--text2':   '#888888',
        '--text3':   '#555555',
      }
    },
    navy: {
      label: 'Ocean',
      icon: '🌊',
      preview: ['#05101f', '#3B82F6', '#0A1929'],
      vars: {
        '--bg':      '#05101f',
        '--bg2':     '#0A1929',
        '--bg3':     '#112240',
        '--card':    '#0D1B36',
        '--card-h':  '#1A2D4A',
        '--border':  'rgba(59,130,246,0.15)',
        '--accent':  '#3B82F6',
        '--accent2': '#2563EB',
        '--glow':    'rgba(59,130,246,0.25)',
        '--text':    '#E8F4FF',
        '--text2':   '#8EB4D8',
        '--text3':   '#567BA0',
      }
    },
    purple: {
      label: 'Nebula',
      icon: '🌌',
      preview: ['#0D0814', '#A855F7', '#160D26'],
      vars: {
        '--bg':      '#0D0814',
        '--bg2':     '#160D26',
        '--bg3':     '#1E1035',
        '--card':    '#180F28',
        '--card-h':  '#251540',
        '--border':  'rgba(168,85,247,0.15)',
        '--accent':  '#A855F7',
        '--accent2': '#9333EA',
        '--glow':    'rgba(168,85,247,0.3)',
        '--text':    '#F0EAFF',
        '--text2':   '#B09CCE',
        '--text3':   '#7A6A9A',
      }
    },
    forest: {
      label: 'Forest',
      icon: '🌿',
      preview: ['#060F0A', '#22C55E', '#0D1F14'],
      vars: {
        '--bg':      '#060F0A',
        '--bg2':     '#0D1F14',
        '--bg3':     '#14301E',
        '--card':    '#0F1F15',
        '--card-h':  '#1A3025',
        '--border':  'rgba(34,197,94,0.12)',
        '--accent':  '#22C55E',
        '--accent2': '#16A34A',
        '--glow':    'rgba(34,197,94,0.25)',
        '--text':    '#EAFFEF',
        '--text2':   '#86C49A',
        '--text3':   '#527060',
      }
    },
    light: {
      label: 'Light',
      icon: '☀️',
      preview: ['#F5F5F5', '#E50914', '#FFFFFF'],
      vars: {
        '--bg':      '#F0F0F5',
        '--bg2':     '#FFFFFF',
        '--bg3':     '#E8E8F0',
        '--card':    '#FFFFFF',
        '--card-h':  '#F0F0FA',
        '--border':  'rgba(0,0,0,0.1)',
        '--accent':  '#E50914',
        '--accent2': '#B81D24',
        '--glow':    'rgba(229,9,20,0.15)',
        '--text':    '#111111',
        '--text2':   '#555555',
        '--text3':   '#888888',
      }
    }
  };

  // ── Apply theme ───────────────────────────────────────────────────────────────
  function applyTheme(id) {
    const theme = THEMES[id] || THEMES.dark;
    const root = document.documentElement;
    Object.entries(theme.vars).forEach(([prop, val]) => root.style.setProperty(prop, val));
    localStorage.setItem('xloop-theme', id);
    document.documentElement.dataset.theme = id;
    // Update active state in panel if it's open
    document.querySelectorAll('.theme-swatch').forEach(s => {
      s.classList.toggle('active', s.dataset.theme === id);
    });
  }

  // ── Load saved theme immediately (before paint to prevent FOUC) ──────────────
  const saved = localStorage.getItem('xloop-theme') || 'dark';
  applyTheme(saved);

  // ── Build the theme picker UI ─────────────────────────────────────────────────
  function buildPanel() {
    // Inject CSS for the panel
    const style = document.createElement('style');
    style.textContent = `
      /* Theme toggle button */
      .theme-toggle-btn {
        position: fixed;
        bottom: 80px; right: 16px;
        z-index: 990;
        width: 42px; height: 42px;
        border-radius: 50%;
        background: var(--bg2);
        border: 1px solid var(--border);
        color: var(--text);
        font-size: 1.1rem;
        cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        box-shadow: 0 4px 20px rgba(0,0,0,0.4);
        transition: transform 0.2s, box-shadow 0.2s;
        -webkit-tap-highlight-color: transparent;
      }
      .theme-toggle-btn:hover { transform: scale(1.1); box-shadow: 0 6px 24px rgba(0,0,0,0.5); }
      .theme-toggle-btn svg { pointer-events: none; }
      @media (min-width: 681px) {
        .theme-toggle-btn { bottom: 24px; right: 20px; }
      }

      /* Backdrop */
      .theme-backdrop {
        display: none; position: fixed; inset: 0; z-index: 991;
        background: rgba(0,0,0,0.5);
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
        animation: themeFadeIn 0.2s ease;
      }
      .theme-backdrop.open { display: block; }

      /* Panel */
      .theme-panel {
        display: none; position: fixed; z-index: 992;
        bottom: 140px; right: 16px;
        background: var(--bg2);
        border: 1px solid var(--border);
        border-radius: 20px;
        padding: 20px;
        min-width: 280px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.7);
        animation: themePanelIn 0.25s cubic-bezier(0.2,0.8,0.2,1);
      }
      .theme-panel.open { display: block; }
      @media (min-width: 681px) {
        .theme-panel { bottom: 80px; right: 20px; }
      }
      @media (max-width: 380px) {
        .theme-panel { right: 10px; left: 10px; min-width: unset; }
      }

      @keyframes themePanelIn {
        from { opacity: 0; transform: translateY(16px) scale(0.95); }
        to   { opacity: 1; transform: translateY(0) scale(1); }
      }
      @keyframes themeFadeIn {
        from { opacity: 0; } to { opacity: 1; }
      }

      .theme-panel-title {
        font-size: 0.72rem; font-weight: 700; text-transform: uppercase;
        letter-spacing: 0.08em; color: var(--text2);
        margin-bottom: 14px;
      }

      /* Theme swatches grid */
      .theme-swatches {
        display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px;
      }
      .theme-swatch {
        border-radius: 12px; padding: 10px 8px;
        border: 2px solid transparent;
        background: var(--bg3);
        cursor: pointer; transition: all 0.2s;
        text-align: center;
        -webkit-tap-highlight-color: transparent;
        position: relative; overflow: hidden;
      }
      .theme-swatch:hover { border-color: var(--accent); transform: translateY(-2px); }
      .theme-swatch.active {
        border-color: var(--accent);
        box-shadow: 0 0 0 3px var(--glow);
      }
      .theme-swatch.active::after {
        content: '✓';
        position: absolute; top: 4px; right: 6px;
        font-size: 0.65rem; color: var(--accent);
        font-weight: 900;
      }
      .swatch-dots {
        display: flex; gap: 4px; justify-content: center; margin-bottom: 8px;
      }
      .swatch-dot {
        width: 12px; height: 12px; border-radius: 50%;
        flex-shrink: 0;
        border: 1px solid rgba(255,255,255,0.1);
      }
      .swatch-icon { font-size: 1rem; margin-bottom: 4px; display: block; }
      .swatch-label { font-size: 0.72rem; font-weight: 600; color: var(--text2); }
      .theme-swatch.active .swatch-label { color: var(--text); }
    `;
    document.head.appendChild(style);

    // Backdrop
    const backdrop = document.createElement('div');
    backdrop.className = 'theme-backdrop';
    backdrop.id = 'themeBackdrop';
    backdrop.addEventListener('click', closePanel);

    // Panel
    const panel = document.createElement('div');
    panel.className = 'theme-panel';
    panel.id = 'themePanel';
    panel.innerHTML = `<div class="theme-panel-title">🎨 Choose Theme</div>
      <div class="theme-swatches" id="themeSwatches"></div>`;

    // Swatches
    const swatchContainer = panel.querySelector('#themeSwatches');
    Object.entries(THEMES).forEach(([id, t]) => {
      const swatch = document.createElement('button');
      swatch.className = 'theme-swatch';
      swatch.dataset.theme = id;
      if (id === saved) swatch.classList.add('active');
      swatch.innerHTML = `
        <div class="swatch-dots">
          ${t.preview.map(c => `<div class="swatch-dot" style="background:${c}"></div>`).join('')}
        </div>
        <span class="swatch-icon">${t.icon}</span>
        <span class="swatch-label">${t.label}</span>
      `;
      swatch.addEventListener('click', () => {
        applyTheme(id);
        // Quick haptic on mobile
        if (navigator.vibrate) navigator.vibrate(10);
      });
      swatchContainer.appendChild(swatch);
    });

    // Toggle button
    const btn = document.createElement('button');
    btn.className = 'theme-toggle-btn';
    btn.id = 'themeToggleBtn';
    btn.title = 'Change Theme';
    btn.setAttribute('aria-label', 'Change theme');
    btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="4"/>
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>
    </svg>`;
    btn.addEventListener('click', togglePanel);

    document.body.appendChild(backdrop);
    document.body.appendChild(panel);
    document.body.appendChild(btn);
  }

  function togglePanel() {
    const panel = document.getElementById('themePanel');
    const backdrop = document.getElementById('themeBackdrop');
    const isOpen = panel.classList.contains('open');
    panel.classList.toggle('open', !isOpen);
    backdrop.classList.toggle('open', !isOpen);
  }
  function closePanel() {
    document.getElementById('themePanel')?.classList.remove('open');
    document.getElementById('themeBackdrop')?.classList.remove('open');
  }

  // Build panel after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildPanel);
  } else {
    buildPanel();
  }

  // Expose globally so other scripts can switch theme programmatically
  window.XloopTheme = { apply: applyTheme, themes: Object.keys(THEMES) };
})();
