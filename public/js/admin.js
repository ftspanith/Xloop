// Admin Utility Functions

function showToast(msg, isError = false) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.className = 'toast show ' + (isError ? 'error' : 'success');
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

function getToken() {
  return localStorage.getItem('xloop_admin_token');
}

function logout() {
  localStorage.removeItem('xloop_admin_token');
  window.location.href = '/admin/login.html';
}

async function checkAuth() {
  const token = getToken();
  if (!token) {
    if(!window.location.pathname.includes('login.html')) {
        window.location.href = '/admin/login.html';
    }
    return false;
  }
  
  try {
    const res = await fetch('/api/auth/verify', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('Invalid token');
    return true;
  } catch (err) {
    logout();
    return false;
  }
}

async function apiFetch(url, options = {}) {
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  };
  
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(url, { ...options, headers, cache: 'no-store' });
  const data = await res.json();
  
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) logout();
    throw new Error(data.message || 'API request failed');
  }
  return data;
}

// ── Mobile sidebar (shared across all admin pages) ───────────────────────────
function openMobileSidebar() {
  const sb = document.getElementById('adminSidebar');
  const bd = document.getElementById('sidebarBackdrop');
  if (sb) sb.classList.add('open');
  if (bd) {
    bd.classList.add('visible');
    bd.setAttribute('aria-hidden', 'false');
  }
  document.body.style.overflow = 'hidden';
}
function closeMobileSidebar() {
  const sb = document.getElementById('adminSidebar');
  const bd = document.getElementById('sidebarBackdrop');
  if (sb) sb.classList.remove('open');
  if (bd) {
    bd.classList.remove('visible');
    bd.setAttribute('aria-hidden', 'true');
  }
  document.body.style.overflow = '';
}


// Close the admin drawer with the Escape key on mobile.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMobileSidebar();
});
