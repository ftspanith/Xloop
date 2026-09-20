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
