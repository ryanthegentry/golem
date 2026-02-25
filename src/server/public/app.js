// Golem PWA — Vanilla JS

(function () {
  'use strict';

  // --- State ---
  let balance = null;
  let transactions = [];
  let walletInfo = null;
  let addresses = null;
  let agentStatus = 'connecting'; // 'online' | 'refreshing' | 'error' | 'connecting'
  let lastAgentEvent = null;

  // --- DOM refs ---
  const $ = (sel) => document.querySelector(sel);
  const balanceBtc = $('#balance-btc');
  const balanceSats = $('#balance-sats');
  const statusDot = $('#status-dot');
  const statusLabel = $('#status-label');
  const agentCardDot = $('#agent-card-dot');
  const agentCardDetail = $('#agent-card-detail');
  const txList = $('#tx-list');
  const sendError = $('#send-error');
  const sendSuccess = $('#send-success');
  const sendAmountInput = $('#send-amount');
  const oorLimitEl = $('#oor-limit');
  const sendBtcEquiv = $('#send-btc-equiv');

  // --- Formatting ---

  function satsToBtc(sats) {
    return (sats / 1e8).toFixed(8);
  }

  function formatSats(sats) {
    return Number(sats).toLocaleString();
  }

  function truncateAddr(addr) {
    if (!addr || addr.length < 16) return addr || '';
    return addr.slice(0, 10) + '...' + addr.slice(-6);
  }

  function timeAgo(ts) {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    const days = Math.floor(hrs / 24);
    return days + 'd ago';
  }

  // --- UI Updates ---

  function updateBalance() {
    if (!balance) return;
    const total = balance.total || 0;
    balanceBtc.textContent = satsToBtc(total);
    balanceSats.textContent = formatSats(total) + ' sats';
    updateBoardingBanner();
  }

  function updateBoardingBanner() {
    var banner = $('#boarding-banner');
    if (!balance || !balance.boarding || balance.boarding.total <= 0) {
      banner.style.display = 'none';
      return;
    }
    banner.style.display = 'flex';
    $('#boarding-detail').textContent = formatSats(balance.boarding.total) + ' sats on-chain';
  }

  function updateAgentStatus() {
    // Dot classes
    statusDot.className = 'status-dot';
    agentCardDot.className = 'status-dot status-dot-sm';

    if (agentStatus === 'online') {
      statusDot.classList.add('online');
      agentCardDot.classList.add('online');
      statusLabel.textContent = 'Online';
    } else if (agentStatus === 'refreshing') {
      statusDot.classList.add('refreshing');
      agentCardDot.classList.add('refreshing');
      statusLabel.textContent = 'Refreshing';
    } else if (agentStatus === 'error') {
      statusDot.classList.add('error');
      agentCardDot.classList.add('error');
      statusLabel.textContent = 'Error';
    } else {
      statusLabel.textContent = 'Connecting';
    }

    // Agent card detail
    if (lastAgentEvent) {
      const ts = lastAgentEvent.timestamp ? new Date(lastAgentEvent.timestamp).getTime() : 0;
      const ago = ts ? timeAgo(ts) : '';

      if (lastAgentEvent.type === 'check') {
        agentCardDetail.textContent = 'Last check ' + ago + ' \u2014 '
          + lastAgentEvent.vtxoCount + ' position' + (lastAgentEvent.vtxoCount !== 1 ? 's' : '')
          + ' monitored';
      } else if (lastAgentEvent.type === 'refresh_ok') {
        agentCardDetail.textContent = 'Funds renewed ' + ago;
      } else if (lastAgentEvent.type === 'refresh_error') {
        agentCardDetail.textContent = 'Error: ' + lastAgentEvent.error;
      } else if (lastAgentEvent.type === 'consolidation_ok') {
        agentCardDetail.textContent = 'Consolidated ' + lastAgentEvent.inputCount + ' positions ' + ago;
      } else {
        agentCardDetail.textContent = lastAgentEvent.type + ' ' + ago;
      }
    }
  }

  function updateTransactions() {
    if (!transactions || transactions.length === 0) {
      txList.innerHTML = '<div class="tx-empty">No transactions yet</div>';
      return;
    }

    txList.innerHTML = transactions.map((tx) => {
      const isSent = tx.type === 'SENT';
      const typeClass = isSent ? 'sent' : 'received';
      const sign = isSent ? '-' : '+';
      const label = isSent ? 'Sent' : 'Received';
      const date = tx.createdAt ? timeAgo(tx.createdAt) : '';
      const settledLabel = tx.settled ? 'Settled' : 'Pending';

      return '<div class="tx-item">'
        + '<div class="tx-item-left">'
        + '<span class="tx-type ' + typeClass + '">' + label + '</span>'
        + '<span class="tx-date">' + date + '</span>'
        + '</div>'
        + '<div class="tx-item-right">'
        + '<div class="tx-amount ' + typeClass + '">' + sign + formatSats(tx.amount) + ' sats</div>'
        + '<div class="tx-settled">' + settledLabel + '</div>'
        + '</div>'
        + '</div>';
    }).join('');
  }

  function updateOorLimit() {
    if (!walletInfo) return;
    oorLimitEl.textContent = 'Send limit: ' + formatSats(walletInfo.oorLimit) + ' sats per transaction';
  }

  // --- Send amount BTC equiv ---

  sendAmountInput.addEventListener('input', () => {
    const val = parseInt(sendAmountInput.value, 10);
    if (val > 0) {
      sendBtcEquiv.textContent = satsToBtc(val) + ' BTC';
    } else {
      sendBtcEquiv.textContent = '';
    }
  });

  // --- API calls ---

  async function fetchBalance() {
    try {
      const res = await fetch('/api/balance');
      if (!res.ok) return;
      balance = await res.json();
      updateBalance();
    } catch (e) {
      // silent
    }
  }

  async function fetchTransactions() {
    try {
      const res = await fetch('/api/transactions');
      if (!res.ok) return;
      transactions = await res.json();
      updateTransactions();
    } catch (e) {
      // silent
    }
  }

  async function fetchAddresses() {
    try {
      const res = await fetch('/api/address');
      if (!res.ok) return;
      addresses = await res.json();
      $('#recv-ark-addr').textContent = addresses.ark;
      $('#recv-boarding-addr').textContent = addresses.boarding;
    } catch (e) {
      // silent
    }
  }

  async function fetchInfo() {
    try {
      const res = await fetch('/api/info');
      if (!res.ok) return;
      walletInfo = await res.json();
      updateOorLimit();
    } catch (e) {
      // silent
    }
  }

  async function fetchAgentStatus() {
    try {
      const res = await fetch('/api/agent/status');
      if (!res.ok) return;
      const data = await res.json();
      if (data.lastEvent) {
        lastAgentEvent = data.lastEvent;
        deriveAgentStatus(data.lastEvent);
      }
      if (data.running) {
        if (agentStatus === 'connecting') {
          agentStatus = 'online';
        }
      }
      updateAgentStatus();
    } catch (e) {
      // silent
    }
  }

  function deriveAgentStatus(event) {
    if (!event) return;
    if (event.type === 'refresh_start' || event.type === 'consolidation_start') {
      agentStatus = 'refreshing';
    } else if (event.type === 'refresh_error') {
      agentStatus = 'error';
    } else {
      agentStatus = 'online';
    }
  }

  // --- SSE for agent events ---

  function connectSSE() {
    const es = new EventSource('/api/agent/events');

    es.addEventListener('check', (e) => handleAgentEvent(JSON.parse(e.data)));
    es.addEventListener('refresh_start', (e) => handleAgentEvent(JSON.parse(e.data)));
    es.addEventListener('refresh_ok', (e) => handleAgentEvent(JSON.parse(e.data)));
    es.addEventListener('refresh_error', (e) => handleAgentEvent(JSON.parse(e.data)));
    es.addEventListener('consolidation_start', (e) => handleAgentEvent(JSON.parse(e.data)));
    es.addEventListener('consolidation_ok', (e) => handleAgentEvent(JSON.parse(e.data)));
    es.addEventListener('consolidation_skip', (e) => handleAgentEvent(JSON.parse(e.data)));
    es.addEventListener('stopped', (e) => handleAgentEvent(JSON.parse(e.data)));

    es.onerror = () => {
      agentStatus = 'error';
      updateAgentStatus();
    };

    es.onopen = () => {
      if (agentStatus === 'connecting' || agentStatus === 'error') {
        agentStatus = 'online';
        updateAgentStatus();
      }
    };
  }

  function handleAgentEvent(event) {
    lastAgentEvent = event;
    deriveAgentStatus(event);
    updateAgentStatus();

    // Refresh data after agent actions
    if (event.type === 'refresh_ok' || event.type === 'consolidation_ok') {
      fetchBalance();
      fetchTransactions();
    }
  }

  // --- Onboard ---

  $('#btn-onboard').addEventListener('click', async () => {
    var btn = $('#btn-onboard');
    btn.disabled = true;
    btn.textContent = 'Boarding...';

    try {
      var res = await fetch('/api/onboard', { method: 'POST' });
      var data = await res.json();

      if (!res.ok) {
        btn.textContent = 'Error';
        setTimeout(function () { btn.textContent = 'Board into Ark'; btn.disabled = false; }, 3000);
        return;
      }

      btn.textContent = 'Boarded!';
      fetchBalance();
      fetchTransactions();
      setTimeout(function () { btn.textContent = 'Board into Ark'; btn.disabled = false; }, 3000);
    } catch (e) {
      btn.textContent = 'Error';
      setTimeout(function () { btn.textContent = 'Board into Ark'; btn.disabled = false; }, 3000);
    }
  });

  // --- Send ---

  $('#btn-confirm-send').addEventListener('click', async () => {
    const address = $('#send-address').value.trim();
    const amount = parseInt(sendAmountInput.value, 10);

    sendError.textContent = '';
    sendSuccess.textContent = '';

    if (!address) {
      sendError.textContent = 'Enter an address';
      return;
    }
    if (!amount || amount <= 0) {
      sendError.textContent = 'Enter a valid amount';
      return;
    }

    const btn = $('#btn-confirm-send');
    btn.disabled = true;
    btn.textContent = 'Sending...';

    try {
      const res = await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, amount }),
      });

      const data = await res.json();

      if (!res.ok) {
        sendError.textContent = data.error || 'Send failed';
        return;
      }

      sendSuccess.textContent = 'Sent! TX: ' + data.txid;
      $('#send-address').value = '';
      sendAmountInput.value = '';
      sendBtcEquiv.textContent = '';

      // Refresh data
      fetchBalance();
      fetchTransactions();
      fetchInfo();
    } catch (e) {
      sendError.textContent = 'Network error';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send';
    }
  });

  // --- Modals ---

  function openModal(name) {
    $('#view-' + name).classList.add('active');
    if (name === 'receive' && !addresses) {
      fetchAddresses();
    }
    if (name === 'send') {
      sendError.textContent = '';
      sendSuccess.textContent = '';
      fetchInfo();
    }
  }

  function closeModal(name) {
    $('#view-' + name).classList.remove('active');
  }

  $('#btn-send').addEventListener('click', () => openModal('send'));
  $('#btn-receive').addEventListener('click', () => openModal('receive'));

  // Close buttons & backdrops
  document.querySelectorAll('[data-close]').forEach((el) => {
    el.addEventListener('click', () => closeModal(el.dataset.close));
  });

  // Copy buttons
  document.querySelectorAll('[data-copy]').forEach((el) => {
    el.addEventListener('click', () => {
      const target = $('#' + el.dataset.copy);
      if (target && target.textContent) {
        navigator.clipboard.writeText(target.textContent).then(() => {
          el.textContent = 'Copied';
          setTimeout(() => { el.textContent = 'Copy'; }, 1500);
        });
      }
    });
  });

  // --- Polling ---

  fetchBalance();
  fetchTransactions();
  fetchAgentStatus();
  fetchInfo();

  setInterval(fetchBalance, 10_000);
  setInterval(fetchTransactions, 30_000);

  // Refresh on visibility
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      fetchBalance();
      fetchTransactions();
      fetchAgentStatus();
    }
  });

  // --- SSE ---
  connectSSE();

  // --- Service Worker ---
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
})();
