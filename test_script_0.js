
  let selectedMode    = 1;
  let selectedChannels = [];
  let allChannels      = [];

  // (Upload logic has been moved to dashboard.html)

  //  Load channel list from API 
  async function loadChannels() {
    try {
      const res  = await apiFetch('/api/scrape/channels');
      allChannels = res.channels || [];
      renderChannels();
    } catch(e) {
      document.getElementById('channelGrid').innerHTML = '<p style="color:#f87171;font-size:0.82rem;">Failed to load channels</p>';
    }
  }

  function renderChannels() {
    const grid = document.getElementById('channelGrid');
    grid.innerHTML = allChannels.map((id, i) => `
      <div class="channel-chip ${selectedChannels.includes(id) ? 'selected' : ''}" onclick="toggleChannel(${id})" id="chip-${id}">
        <span class="chip-dot"></span>
        <span>${id}</span>
      </div>
    `).join('');
  }

  function toggleChannel(id) {
    const idx = selectedChannels.indexOf(id);
    if (idx === -1) selectedChannels.push(id);
    else selectedChannels.splice(idx, 1);
    renderChannels();
  }

  function toggleAllChannels(select) {
    selectedChannels = select ? [...allChannels] : [];
    renderChannels();
  }

  function addCustomChannels() {
    const input = document.getElementById('customChannelsInput').value;
    if (!input) return;
    const newIds = input.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    if (newIds.length === 0) return showToast('Please enter valid channel IDs', true);
    
    newIds.forEach(id => {
      if (!allChannels.includes(id)) {
        allChannels.push(id);
      }
      if (!selectedChannels.includes(id)) {
        selectedChannels.push(id);
      }
    });
    
    document.getElementById('customChannelsInput').value = '';
    renderChannels();
    showToast(`Added ${newIds.length} custom channel(s)`);
  }

  //  Mode selection 
  function selectMode(m) {
    selectedMode = m;
    document.querySelectorAll('.mode-card').forEach((c, i) => {
      c.classList.toggle('selected', i + 1 === m);
    });

    const channelPanel = document.getElementById('channelPanel');
    const daysPanel    = document.getElementById('daysPanel');

    channelPanel.classList.toggle('visible', m === 2 || m === 3 || m === 4);
    daysPanel.classList.toggle('visible',    m === 3);
  }

  function setDailyScrape() {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    
    document.getElementById('startDateInput').value = yesterday.toISOString().split('T')[0];
    document.getElementById('endDateInput').value = today.toISOString().split('T')[0];
    showToast('Date range set to Daily Scrape');
  }

  // ── Generate terminal command based on selected options ───────────────────
  function generateCommand() {
    const startDate = document.getElementById('startDateInput')?.value || '';
    const endDate   = document.getElementById('endDateInput')?.value   || '';
    const acc       = document.getElementById('accountSelect')?.value  || '1';

    let cmd = 'node scrape-and-upload.js';
    let desc = '';

    switch (selectedMode) {
      case 1:
        cmd  += ' --mode=1';
        desc  = 'Full scrape — ALL channels, ALL history. Takes 1–3 hours.';
        break;
      case 2:
        const chIds = selectedChannels.length > 0 ? selectedChannels.join(',') : 'all';
        cmd  += ` --mode=2 --channels=${chIds}`;
        desc  = `Scrapes ${selectedChannels.length || 'all'} specific channel(s) fully.`;
        break;
      case 3:
        if (startDate) {
          cmd  += ` --mode=3 --start-date=${startDate}`;
          if (endDate) cmd += ` --end-date=${endDate}`;
          desc  = `Date range: ${startDate} → ${endDate || 'now'}`;
        } else {
          cmd  += ' --mode=3 --days=1';
          desc  = 'Last 24 hours from all channels. Change --days=N for more.';
        }
        break;
      case 4:
        cmd  += ' --mode=4';
        desc  = ' Fastest — only new messages since last scrape. Use for daily updates.';
        break;
    }

    if (acc === '2') {
      cmd += ' --account=2';
      desc += ' Uses Account 2 (merges automatically without wiping old links). Outputs to telegram_export_2.json';
    }

    document.getElementById('generatedCmd').textContent   = cmd;
    document.getElementById('cmdDescription').textContent = desc;
    document.getElementById('commandPanel').style.display = 'block';
    document.getElementById('commandPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function copyCommand() {
    const cmd = document.getElementById('generatedCmd').textContent;
    navigator.clipboard.writeText(cmd).then(() => {
      showToast(' Command copied to clipboard!');
    }).catch(() => {
      // Fallback
      const el = document.createElement('textarea');
      el.value = cmd; document.body.appendChild(el);
      el.select(); document.execCommand('copy');
      document.body.removeChild(el);
      showToast(' Command copied!');
    });
  }

  //  Start Scrape (kept for upload-only flow via SSE)
  async function startScrape() {
    const btn       = document.getElementById('startBtn');
    const logBox    = document.getElementById('logBox');
    const logStatus = document.getElementById('logStatus');
    const logSection= document.getElementById('logSection');
    const doneBanner= document.getElementById('doneBanner');

    // Validate
    if ((selectedMode === 2 || selectedMode === 3 || selectedMode === 4) && selectedChannels.length === 0) {
      showToast('Please select at least one channel', true); return;
    }

    const startDate = document.getElementById('startDateInput').value;
    const endDate   = document.getElementById('endDateInput').value;

    btn.disabled  = true;
    btn.innerHTML = '<span class="spinner-sm"></span> Scraping...';
    logSection.classList.add('visible');
    doneBanner.classList.remove('visible');
    logBox.innerHTML = '';
    logStatus.className = 'running';
    logStatus.textContent = ' Running';

    const body = {
      mode:     selectedMode,
      channels: (selectedMode === 1) ? [] : selectedChannels,
      startDate: startDate,
      endDate:   endDate
    };

    try {
      const res = await fetch('/api/scrape/start', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('gp_token')}` },
        body:    JSON.stringify(body),
      });

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buffer  = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop();

        for (const part of parts) {
          const line = part.replace(/^data: /, '').trim();
          if (!line) continue;
          try {
            const ev = JSON.parse(line);
            appendLog(ev, logBox, logStatus, doneBanner);
          } catch(_) {}
        }
        logBox.scrollTop = logBox.scrollHeight;
      }
    } catch(e) {
      appendLog({ type: 'fail', message: 'Connection lost: ' + e.message }, logBox, logStatus, doneBanner);
    }

    btn.disabled  = false;
    btn.innerHTML = '<span></span> Start Scrape';
  }

  function appendLog(ev, logBox, logStatus, doneBanner) {
    const div = document.createElement('div');
    div.className = 'log-line';

    if (ev.type === 'error') { div.className += ' log-err'; }
    else if (ev.type === 'done') {
      div.className += ' log-ok';
      logStatus.className   = 'done';
      logStatus.textContent = ' Done';
      doneBanner.classList.add('visible');
      document.getElementById('doneFileSize').textContent = ev.fileSize ? `Output file: ${ev.fileSize}` : '';
    } else if (ev.type === 'fail') {
      div.className += ' log-err';
      logStatus.className   = 'fail';
      logStatus.textContent = ' Failed';
    } else if (ev.type === 'start') {
      div.className += ' log-head';
    }

    div.textContent = ev.message;
    logBox.appendChild(div);
    logBox.scrollTop = logBox.scrollHeight;
  }

  //  Init 
  checkAuth().then(valid => {
    if (valid) {
      loadChannels();
      checkExportStatus();
      // Pre-select all channels by default
      setTimeout(() => {
        if (allChannels.length > 0) {
          selectedChannels = [...allChannels];
          renderChannels();
        }
      }, 500);
    }
  });
