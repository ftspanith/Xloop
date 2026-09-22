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
    // Load hero (featured movie)
    const fRes = await fetch('/api/movies/featured');
    const featured = await fRes.json();
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
          bg.style.opacity = 0.5;
          
          content.innerHTML = `
            <div class="hero-badge">Featured</div>
            <h1 class="hero-title">${hero.title}</h1>
            <div class="hero-meta">
              <span class="rating"> ${hero.rating}</span>
              <span class="dot"></span>
              <span>${hero.year}</span>
              <span class="dot"></span>
              <span>${hero.quality || 'HD'}</span>
              <span class="dot"></span>
              <span>${hero.duration || ''}</span>
            </div>
            <div class="hero-genres">
              ${(hero.genre||[]).map(g => `<span class="genre-pill">${g}</span>`).join('')}
            </div>
            <p class="hero-desc">${hero.description || ''}</p>
            <div class="hero-btns">
              <a href="/watch.html?id=${hero._id}&type=${hero.type}" class="btn-watch" style="background: #E50914; border-radius: 4px; padding: 12px 28px; font-weight: bold; color: white;">
                 Get Links
              </a>
              <a href="/watch.html?id=${hero._id}&type=${hero.type}" class="btn-info" style="background: rgba(255,255,255,0.2); border-radius: 4px; padding: 12px 28px; border: none; font-weight: bold; color: white;">
                More Info
              </a>
            </div>
          `;
          content.style.opacity = 1;
          
          if (dots) {
            dots.innerHTML = featured.map((_, i) => `<span class="dot ${i === heroIdx ? 'active' : ''}" onclick="setHero(${i})" style="cursor:pointer; width:10px; height:10px; background: ${i === heroIdx ? 'white' : 'rgba(255,255,255,0.3)'}; border-radius:50%; display:inline-block; margin:0 5px; transition:0.3s;"></span>`).join('');
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
        const res = await fetch(url);
        const items = await res.json();
        const el = document.getElementById(id);
        if(el) {
          if (items.length === 0) {
            el.innerHTML = '<div class="empty-state">No content yet</div>';
          } else {
            el.innerHTML = items.map((item, index) => isWide ? createWideCard(item, item.type || type, index) : createCard(item, item.type || type, index)).join('');
            activateLazyImages();
          }
        }
      } catch (e) { console.error('Slider load error:', e); }
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
