document.addEventListener('DOMContentLoaded', async () => {
  const urlParams    = new URLSearchParams(window.location.search);
  const q            = urlParams.get('q') || '';

  const searchInput  = document.getElementById('mainSearchInput');
  const searchForm   = document.getElementById('mainSearchForm');
  const resultsGrid  = document.getElementById('searchResults');
  const searchCount  = document.getElementById('searchCount');
  const resultsHeader = document.getElementById('searchResultsHeader');

  if (q) {
    searchInput.value = q;
    await performSearch(q);
  }

  searchForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const query = searchInput.value.trim();
    if (query) {
      window.history.pushState({}, '', `?q=${encodeURIComponent(query)}`);
      await performSearch(query);
    }
  });

  async function performSearch(query) {
    resultsGrid.innerHTML = '<div class="spinner"></div>';
    if (resultsHeader) resultsHeader.style.display = 'flex';

    try {
      const res  = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=48`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      // Use canonical 'results' array; fall back to legacy movies+series arrays
      const items = Array.isArray(data.results) && data.results.length > 0
        ? data.results
        : [...(data.movies || []), ...(data.series || [])];

      if (items.length === 0) {
        resultsGrid.innerHTML = `<div class="empty-state">No results found for "<strong>${query}</strong>"</div>`;
      } else {
        resultsGrid.innerHTML = items.map((item, i) =>
          createCard(item, item.type || 'movie', i)
        ).join('');
        // Activate lazy loading for newly inserted poster images
        activateLazyImages();
      }

      if (searchCount) {
        searchCount.innerHTML = `Found <strong>${data.total || items.length}</strong> results for "<strong>${query}</strong>"`;
      }
    } catch (err) {
      console.error('Search error:', err);
      resultsGrid.innerHTML = '<div class="empty-state">Search failed. Please try again.</div>';
    }
  }
});
