// Helper functions for rendering cards
function getInitials(title) {
  return title.split(' ').slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '??';
}

function createCard(item, type, index = 0) {
  const isMovie = type === 'movie';
  const url = `/watch.html?id=${item._id}&type=${type}`;
  
  // Top-left main badge — show actual type
  const actualType = item.type || type;
  const topBadge = isMovie
    ? (item.quality === '4K' ? '<div class="card-badge hd">4K</div>' : '<div class="card-badge">HD</div>')
    : actualType === 'anime'
      ? '<div class="card-badge" style="background:#8b5cf6">ANIME</div>'
      : '<div class="card-badge">SERIES</div>';
  
  // Bottom info dynamic badges
  let badgesHtml = '';
  
  if (item.codecs && item.codecs.length > 0) {
    badgesHtml += item.codecs.map(c => `<span class="c-badge c-badge-glass c-codec">${c}</span>`).join('');
  }
  
  if (item.languages && item.languages.length > 0) {
    const langs = item.languages.filter(l => l.toLowerCase() !== 'unknown').slice(0, 3);
    badgesHtml += langs.map(l => `<span class="c-badge c-badge-glass c-lang">${l}</span>`).join('');
    const validLangsCount = item.languages.filter(l => l.toLowerCase() !== 'unknown').length;
    if (validLangsCount > 3) badgesHtml += `<span class="c-badge c-badge-glass c-lang">+${validLangsCount-3}</span>`;
  }

  const delay = (index * 0.05).toFixed(2);
  const poster = item.poster || '';
  const initials = getInitials(item.title);

  const imgOrPlaceholder = poster
    ? `<img
        src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
        data-src="${poster}"
        alt="${item.title}"
        class="card-img lazy-img"
        onerror="this.style.display='none';this.nextElementSibling.style.display='flex';"
        onload="this.classList.add('loaded')"
      >
      <div class="card-no-poster" style="display:none">
        <div class="np-initials">${initials}</div>
        <div class="np-title">${item.title}</div>
      </div>`
    : `<div class="card-no-poster">
        <div class="np-initials">${initials}</div>
        <div class="np-title">${item.title}</div>
      </div>`;

  return `
    <a href="${url}" class="card" style="animation-delay: ${delay}s">
      ${topBadge}
      ${imgOrPlaceholder}
      <div class="card-info">
        <div class="card-title">${item.title}</div>
        <div class="card-sub">${item.year || ''} • ${isMovie ? 'Movie' : (item.type === 'anime' ? 'Anime' : 'Series')}</div>
        <div class="card-badges-row">${badgesHtml}</div>
      </div>
    </a>
  `;
}

function createWideCard(item, type, index = 0) {
  const url = `/watch.html?id=${item._id}&type=${type}`;
  const delay = (index * 0.05).toFixed(2);
  const img = item.backdrop || item.poster || '';
  const initials = getInitials(item.title);

  // Bottom info dynamic badges
  let badgesHtml = '';
  
  if (item.codecs && item.codecs.length > 0) {
    badgesHtml += item.codecs.map(c => `<span class="c-badge c-badge-glass c-codec">${c}</span>`).join('');
  }
  
  if (item.languages && item.languages.length > 0) {
    const langs = item.languages.filter(l => l.toLowerCase() !== 'unknown').slice(0, 3);
    badgesHtml += langs.map(l => `<span class="c-badge c-badge-glass c-lang">${l}</span>`).join('');
    const validLangsCount = item.languages.filter(l => l.toLowerCase() !== 'unknown').length;
    if (validLangsCount > 3) badgesHtml += `<span class="c-badge c-badge-glass c-lang">+${validLangsCount-3}</span>`;
  }

  const imgOrPlaceholder = img
    ? `<img
        src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
        data-src="${img}"
        alt="${item.title}"
        class="card-img lazy-img"
        style="aspect-ratio:16/9"
        onerror="this.style.display='none';this.nextElementSibling.style.display='flex';"
        onload="this.classList.add('loaded')"
      >
      <div class="card-no-poster wide" style="display:none">
        <div class="np-initials">${initials}</div>
        <div class="np-title">${item.title}</div>
      </div>`
    : `<div class="card-no-poster wide">
        <div class="np-initials">${initials}</div>
        <div class="np-title">${item.title}</div>
      </div>`;

  return `
    <a href="${url}" class="card-wide" style="animation-delay: ${delay}s">
      <div class="card-badge new">NEW</div>
      ${imgOrPlaceholder}
      <div class="card-info">
        <div class="card-title">${item.title}</div>
        <div class="card-sub"><span class="card-star"></span> ${item.rating || 'N/A'} • ${item.genre && item.genre[0] ? item.genre[0] : ''}</div>
        <div class="card-badges-row">${badgesHtml}</div>
      </div>
    </a>
  `;
}

// Lazy image loader using IntersectionObserver
function activateLazyImages() {
  const images = document.querySelectorAll('img.lazy-img');
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const img = entry.target;
          img.src = img.dataset.src;
          observer.unobserve(img);
        }
      });
    }, { rootMargin: '100px' });
    images.forEach(img => observer.observe(img));
  } else {
    // Fallback for old browsers
    images.forEach(img => { img.src = img.dataset.src; });
  }
}

// Slider logic
function scrollSlider(id, dir) {
  const slider = document.getElementById(id);
  if (slider) slider.scrollBy({ left: dir * 300, behavior: 'smooth' });
}

// Fetch and load data into grid
async function loadGrid(url, containerId, options = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;

  try {
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Normalise: some endpoints return a bare array, others wrap in {movies}/{series}/{results}
    let items = Array.isArray(data) ? data
              : Array.isArray(data.movies)  ? data.movies
              : Array.isArray(data.series)  ? data.series
              : Array.isArray(data.results) ? data.results
              : [];

    if (items.length === 0) {
      container.innerHTML = '<div class="empty-state">No content found</div>';
      return;
    }

    let html = '';
    items.forEach((item, index) => {
      html += createCard(item, item.type || options.type || 'movie', index);
    });
    container.innerHTML = html;
    activateLazyImages();
  } catch (err) {
    console.error('loadGrid error:', url, err.message);
    container.innerHTML = '<div class="empty-state">Failed to load content</div>';
  }
}

// Homepage specific loads
async function loadHomepage() {
  if (!document.getElementById('heroBg')) return;
  
  try {
    // Load hero (featured movie). A failed/empty response must never leave
    // the initial spinner running or prevent the remaining homepage sections.
    let featured = [];
    try {
      const fRes = await fetch('/api/movies/featured', { cache: 'no-store' });
      if (!fRes.ok) throw new Error(`HTTP ${fRes.status}`);
      const featuredData = await fRes.json();
      featured = Array.isArray(featuredData) ? featuredData
        : Array.isArray(featuredData?.movies) ? featuredData.movies
        : Array.isArray(featuredData?.results) ? featuredData.results
        : [];
    } catch (heroError) {
      console.error('Featured content load error:', heroError);
      const heroContent = document.getElementById('heroContent');
      if (heroContent) heroContent.innerHTML = '<div class="empty-state">Featured content is temporarily unavailable.</div>';
    }

    if (featured.length > 0) {
      let heroIdx = 0;
      let heroInterval;

      window.setHero = (idx) => {
        heroIdx = idx;
        renderHero();
        resetHeroInterval();
      };

      const renderHero = () => {
        const hero = featured[heroIdx];
        const bg = document.getElementById('heroBg');
        const content = document.getElementById('heroContent');
        const dots = document.getElementById('heroDots');
        
        // Fade out
        bg.style.opacity = 0;
        content.style.opacity = 0;
        
        setTimeout(() => {
          bg.style.backgroundImage = `url(${hero.backdrop || hero.poster})`;
          bg.style.opacity = 0.55;
          
          const rating = hero.rating ? `<span class="rating" style="display:flex;align-items:center;gap:4px;color:#f5c518;font-weight:700;">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="#f5c518"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            ${hero.rating}
          </span><span style="width:3px;height:3px;border-radius:50%;background:rgba(255,255,255,0.4);display:inline-block;"></span>` : '';

          const metaParts = [hero.year, hero.quality || 'HD', hero.duration].filter(Boolean);
          
          content.innerHTML = `
            <div class="hero-badge" style="display:inline-block;background:#e50914;color:#fff;font-size:0.65rem;font-weight:800;letter-spacing:1.5px;padding:3px 10px;border-radius:4px;text-transform:uppercase;margin-bottom:10px;">Featured</div>
            <h1 class="hero-title">${hero.title}</h1>
            <div class="hero-meta" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
              ${rating}
              ${metaParts.map((p,i) => `<span style="color:rgba(255,255,255,0.75);font-size:0.82rem;">${p}</span>${i < metaParts.length-1 ? '<span style="width:3px;height:3px;border-radius:50%;background:rgba(255,255,255,0.4);display:inline-block;"></span>' : ''}`).join('')}
            </div>
            <div class="hero-genres" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">
              ${(hero.genre||[]).slice(0,3).map(g => `<span style="font-size:0.72rem;padding:3px 10px;border-radius:99px;border:1px solid rgba(255,255,255,0.25);color:rgba(255,255,255,0.7);">${g}</span>`).join('')}
            </div>
            <p class="hero-desc" style="font-size:0.85rem;color:rgba(255,255,255,0.7);line-height:1.55;margin-bottom:18px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${hero.description || ''}</p>
            <div class="hero-btns" style="display:flex;gap:10px;flex-wrap:wrap;">
              <a href="/watch.html?id=${hero._id}&type=${hero.type}" class="btn-watch" style="display:inline-flex;align-items:center;gap:7px;background:#e50914;color:#fff;padding:10px 22px;border-radius:6px;font-size:0.88rem;font-weight:700;white-space:nowrap;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                Get Links
              </a>
              <a href="/watch.html?id=${hero._id}&type=${hero.type}" class="btn-info" style="display:inline-flex;align-items:center;gap:7px;background:rgba(255,255,255,0.15);color:#fff;padding:10px 22px;border-radius:6px;font-size:0.88rem;font-weight:700;border:1px solid rgba(255,255,255,0.2);white-space:nowrap;backdrop-filter:blur(4px);">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                More Info
              </a>
            </div>
          `;
          content.style.opacity = 1;
          
          if (dots) {
            dots.innerHTML = featured.map((_, i) => `<button class="hero-dot ${i === heroIdx ? 'active' : ''}" onclick="setHero(${i})" aria-label="Slide ${i+1}"></button>`).join('');
          }
        }, 300);
      };

      const resetHeroInterval = () => {
        clearInterval(heroInterval);
        heroInterval = setInterval(() => {
          heroIdx = (heroIdx + 1) % featured.length;
          renderHero();
        }, 10000);
      };

      renderHero();
      resetHeroInterval();
    }

    // Load Sliders
    const loadSlider = async (url, id, type, isWide = false) => {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = await res.json();
        const items = Array.isArray(payload) ? payload
          : Array.isArray(payload?.movies) ? payload.movies
          : Array.isArray(payload?.results) ? payload.results
          : [];
        const el = document.getElementById(id);
        if (!el) return;
        if (items.length === 0) {
          el.innerHTML = '<div class="empty-state">No content available right now</div>';
        } else {
          el.innerHTML = items.map((item, index) => isWide ? createWideCard(item, item.type || type, index) : createCard(item, item.type || type, index)).join('');
          activateLazyImages();
        }
      } catch (e) {
        console.error('Slider load error:', url, e);
        const el = document.getElementById(id);
        if (el) el.innerHTML = '<div class="empty-state">Unable to load content</div>';
      }
    };
    
    // Main sliders
    loadSlider('/api/movies/this-year', 'featuredSlider', 'movie', true);
    loadSlider('/api/movies/trending', 'continueSlider', 'movie', true);
    loadSlider('/api/movies/top-rated', 'editorSlider', 'movie');
    loadSlider('/api/movies/latest', 'originalsSlider', 'movie');

    // TV Shows sliders (series + anime)
    loadSlider('/api/movies?type=series&limit=15&sort=createdAt', 'tvShowsSlider', 'series');
    loadSlider('/api/movies?type=anime&limit=15&sort=createdAt', 'animeSlider', 'anime');

    // Banners
    loadSlider('/api/movies/this-year', 'thisYearSlider', 'movie');
    loadSlider('/api/movies/top-rated', 'topRatedSlider', 'movie');

    // Regional/Language sliders
    loadSlider('/api/movies/by-language/Telugu', 'teluguSlider', 'movie');
    loadSlider('/api/movies/by-language/Tamil', 'tamilSlider', 'movie');
    loadSlider('/api/movies/by-language/Hindi', 'hindiSlider', 'movie');
    loadSlider('/api/movies/by-language/Malayalam', 'malayalamSlider', 'movie');
    loadSlider('/api/movies/by-language/English', 'englishSlider', 'movie');
    
    // Auto-refresh key sliders every 30s so new imports appear without page reload
    setInterval(() => {
      loadSlider('/api/movies/this-year', 'featuredSlider', 'movie', true);
      loadSlider('/api/movies/latest', 'originalsSlider', 'movie');
      loadSlider('/api/movies?type=series&limit=15&sort=createdAt', 'tvShowsSlider', 'series');
      loadSlider('/api/movies?type=anime&limit=15&sort=createdAt', 'animeSlider', 'anime');
    }, 30000);

    // Auto-scroll all horizontal sliders every 10s
    setTimeout(() => {
      document.querySelectorAll('.slider').forEach(slider => {
        let isHovered = false;
        slider.addEventListener('mouseenter', () => isHovered = true);
        slider.addEventListener('mouseleave', () => isHovered = false);
        
        setInterval(() => {
          if (!isHovered && slider.scrollWidth > slider.clientWidth) {
            if (slider.scrollLeft + slider.clientWidth >= slider.scrollWidth - 10) {
              slider.scrollTo({ left: 0, behavior: 'smooth' });
            } else {
              slider.scrollBy({ left: 300, behavior: 'smooth' });
            }
          }
        }, 10000);
      });
    }, 2000); // give sliders time to populate

  } catch (err) {
    console.error('Error loading homepage:', err);
  }
}

document.addEventListener('DOMContentLoaded', loadHomepage);


// ═══════════════════════════════════════════════════════════════════
//  SHARED CUSTOM SELECT BUILDER
//  Call window.initCustomSelects() after DOM + any dynamic options
//  are ready. Works for any page that has filter-select elements.
//
//  Each <select> can carry data attributes for icon+label:
//    data-icon="<svg…>"  data-label="Genre"
// ═══════════════════════════════════════════════════════════════════
window.initCustomSelects = function (opts) {
  const ICONS = {
    genre:   '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>',
    year:    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    quality: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
    lang:    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/></svg>',
    sort:    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
  };

  // Per-id metadata map (fallback: guess from id)
  const META = Object.assign({
    genreFilter:    { icon: ICONS.genre,   label: 'Genre' },
    yearFilter:     { icon: ICONS.year,    label: 'Year' },
    qualityFilter:  { icon: ICONS.quality, label: 'Quality' },
    langFilter:     { icon: ICONS.lang,    label: 'Language' },
    sortFilter:     { icon: ICONS.sort,    label: 'Sort By' },
  }, opts || {});

  // Close all open dropdowns
  function closeAll(except) {
    document.querySelectorAll('.custom-select').forEach(cs => {
      if (cs !== except) cs.classList.remove('open');
    });
  }

  // Build wrappers for each select
  document.querySelectorAll('select.filter-select').forEach(select => {
    // Skip if already wrapped
    if (select.closest('.custom-select-wrapper')) return;

    select.style.display = 'none';

    // Determine meta — allow data attrs to override
    const id = select.id;
    let meta = META[id] || { icon: '', label: select.dataset.label || '' };
    if (select.dataset.icon)  meta = { icon: select.dataset.icon,  label: meta.label };
    if (select.dataset.label) meta.label = select.dataset.label;

    // Wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'custom-select-wrapper';
    select.parentNode.insertBefore(wrapper, select);
    wrapper.appendChild(select);

    // Pill button
    const pill = document.createElement('div');
    pill.className = 'custom-select';
    pill.setAttribute('role', 'button');
    pill.setAttribute('tabindex', '0');

    const iconEl  = document.createElement('span');
    iconEl.className = 'filter-icon';
    iconEl.innerHTML = meta.icon;

    const labelEl = document.createElement('span');
    labelEl.className = 'label-text';
    labelEl.textContent = select.options[select.selectedIndex]?.text || meta.label;

    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>';

    pill.appendChild(iconEl);
    pill.appendChild(labelEl);
    pill.appendChild(arrow);
    wrapper.appendChild(pill);

    // Dropdown panel
    const panel = document.createElement('div');
    panel.className = 'custom-options';

    // Header label
    if (meta.label) {
      const hdr = document.createElement('div');
      hdr.className = 'custom-options-header';
      hdr.textContent = meta.label;
      panel.appendChild(hdr);
    }

    // Options
    function buildOptions() {
      // Remove old options (not the header)
      Array.from(panel.querySelectorAll('.custom-option')).forEach(el => el.remove());

      Array.from(select.options).forEach((opt, idx) => {
        const item = document.createElement('div');
        item.className = 'custom-option' + (idx === select.selectedIndex ? ' selected' : '');
        item.textContent = opt.text;
        item.addEventListener('click', () => {
          select.selectedIndex = idx;
          labelEl.textContent = opt.text;
          panel.querySelectorAll('.custom-option').forEach(c => c.classList.remove('selected'));
          item.classList.add('selected');
          pill.classList.remove('open');
          pill.classList.toggle('has-value', idx > 0);
          select.dispatchEvent(new Event('change'));
        });
        panel.appendChild(item);
      });
    }
    buildOptions();
    wrapper.appendChild(panel);

    // Re-sync if native select changes programmatically (e.g. reset)
    select.addEventListener('change', () => {
      const si = select.selectedIndex;
      labelEl.textContent = select.options[si]?.text || meta.label;
      pill.classList.toggle('has-value', si > 0);
      panel.querySelectorAll('.custom-option').forEach((c, i) => {
        c.classList.toggle('selected', i === si);
      });
    });

    // If options are added dynamically after init (e.g. year dropdown filled by JS)
    // observe mutations and rebuild
    new MutationObserver(() => buildOptions())
      .observe(select, { childList: true });

    // Toggle open on click/keyboard
    pill.addEventListener('click', e => {
      e.stopPropagation();
      const isOpen = pill.classList.contains('open');
      closeAll();
      pill.classList.toggle('open', !isOpen);
    });
    pill.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pill.click(); }
      if (e.key === 'Escape') pill.classList.remove('open');
    });
  });

  // Close when clicking outside
  if (!window._customSelectDocListener) {
    window._customSelectDocListener = true;
    document.addEventListener('click', () => closeAll());
  }
};

// Mobile Menu Logic — works for pages with inline overlay (index.html) and without
function openMobileNav() {
  let menu = document.getElementById('mobileNavOverlay');
  if (!menu) {
    // Pages like movies.html, shows.html, anime.html etc — create overlay dynamically
    menu = document.createElement('div');
    menu.id = 'mobileNavOverlay';
    menu.className = 'mobile-nav-overlay';
    menu.innerHTML = `
      <button class="mobile-nav-close" onclick="closeMobileNav()" aria-label="Close">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
      <a href="/" class="nav-logo" style="font-size:2rem;letter-spacing:-1px;margin-bottom:16px;">XLOOP</a>
      <a href="/" onclick="closeMobileNav()">Home</a>
      <a href="/movies.html" onclick="closeMobileNav()">Movies</a>
      <a href="/shows.html" onclick="closeMobileNav()">TV Shows</a>
      <a href="/anime.html" onclick="closeMobileNav()">Anime</a>
      <a href="/search.html" onclick="closeMobileNav()">Search</a>
      <a href="/admin/login.html" onclick="closeMobileNav()">Admin</a>
      <div class="mobile-nav-search">
        <input type="text" id="mobileNavSearchInput" placeholder="Search titles..." />
        <button type="button" onclick="mobileNavSearch()">Go</button>
      </div>
    `;
    document.body.appendChild(menu);
  }
  menu.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeMobileNav() {
  const menu = document.getElementById('mobileNavOverlay');
  if (menu) menu.classList.remove('open');
  document.body.style.overflow = '';
}


// Centralized mobile navigation search and keyboard/backdrop controls.
function mobileNavSearch() {
  const input = document.getElementById('mobileNavSearchInput');
  const query = input ? input.value.trim() : '';
  if (!query) return;

  if (
    window.location.pathname.endsWith('/search.html') &&
    typeof window.runSearch === 'function'
  ) {
    window.runSearch(query, 1);
    closeMobileNav();
    return;
  }

  window.location.href = `/search.html?q=${encodeURIComponent(query)}`;
}

document.addEventListener('keydown', function (event) {
  if (event.key === 'Escape') {
    closeMobileNav();
    return;
  }

  if (event.key === 'Enter' && event.target && event.target.id === 'mobileNavSearchInput') {
    event.preventDefault();
    mobileNavSearch();
  }
});

document.addEventListener('click', function (event) {
  const menu = document.getElementById('mobileNavOverlay');
  if (menu && event.target === menu) closeMobileNav();
});
