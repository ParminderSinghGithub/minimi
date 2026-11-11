// minimi client application
let currentSessionId = localStorage.getItem('minimi_session_id') || `sess-${Date.now()}`;
localStorage.setItem('minimi_session_id', currentSessionId);

const chatMessages = document.getElementById('chat-messages');
const chatForm = document.getElementById('chat-form');
const userInput = document.getElementById('user-input');
const btnSend = document.getElementById('btn-send');
const btnSeed = document.getElementById('btn-seed');
const btnNew = document.getElementById('btn-new');
const welcomeCard = document.getElementById('welcome-card');

// Load history on initial startup
loadHistory();

// Event Listeners
chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = userInput.value.trim();
  if (!text) return;
  userInput.value = '';
  await sendMessage(text);
});

userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    chatForm.dispatchEvent(new Event('submit'));
  }
});

btnSeed.addEventListener('click', async () => {
  btnSeed.disabled = true;
  btnSeed.innerHTML = '<span>⚡ Seeding...</span>';
  try {
    const res = await fetch('/api/seed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: currentSessionId }),
    });
    const data = await res.json();
    if (data.success) {
      appendNotification('⚡ Challenge test dataset seeded! You can now test any of the 3 prompts below.');
      await loadHistory();
    }
  } catch (err) {
    appendNotification('❌ Error seeding data: ' + err.message);
  } finally {
    btnSeed.disabled = false;
    btnSeed.innerHTML = '<span class="btn-icon">⚡</span> Seed Challenge History';
  }
});

btnNew.addEventListener('click', () => {
  currentSessionId = `sess-${Date.now()}`;
  localStorage.setItem('minimi_session_id', currentSessionId);
  chatMessages.innerHTML = '';
  if (welcomeCard) chatMessages.appendChild(welcomeCard);
  appendNotification('New conversation session started.');
});

// Quick prompt click handler
document.querySelectorAll('.quick-prompt-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const prompt = btn.getAttribute('data-prompt');
    if (prompt) {
      userInput.value = prompt;
      userInput.focus();
    }
  });
});

async function loadHistory() {
  try {
    const res = await fetch(`/api/history/${currentSessionId}`);
    const data = await res.json();
    if (data.messages && data.messages.length > 0) {
      if (welcomeCard && welcomeCard.parentNode) {
        welcomeCard.parentNode.removeChild(welcomeCard);
      }
      chatMessages.innerHTML = '';
      for (const msg of data.messages) {
        renderMessage(msg.role, msg.content, msg.metadata, msg.createdAt);
      }
      scrollToBottom();
    }
  } catch (err) {
    console.error('Failed to load history:', err);
  }
}

async function sendMessage(text) {
  if (welcomeCard && welcomeCard.parentNode) {
    welcomeCard.parentNode.removeChild(welcomeCard);
  }

  // Render user bubble
  renderMessage('user', text, null, new Date().toISOString());
  scrollToBottom();

  // Render loading placeholder
  const loadingEl = renderLoadingIndicator();
  scrollToBottom();

  try {
    btnSend.disabled = true;
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: currentSessionId,
        message: text,
        currentDate: new Date().toISOString(),
      }),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(errData.error || `HTTP error ${res.status}`);
    }

    const payload = await res.json();

    // Remove loading indicator
    if (loadingEl.parentNode) {
      loadingEl.parentNode.removeChild(loadingEl);
    }

    // Render assistant message
    renderMessage('assistant', payload.content, {
      citations: payload.citations,
      delta: payload.delta,
      searchesExecuted: payload.searchesExecuted,
      temporalContext: payload.temporalContext,
      memoryContextUsed: payload.memoryContextUsed,
    }, new Date().toISOString());

    scrollToBottom();
  } catch (err) {
    if (loadingEl.parentNode) {
      loadingEl.parentNode.removeChild(loadingEl);
    }
    renderMessage('assistant', `⚠️ **Error processing request:** ${err.message}`);
    scrollToBottom();
  } finally {
    btnSend.disabled = false;
    userInput.focus();
  }
}

function renderMessage(role, content, metadata, timestamp) {
  const row = document.createElement('div');
  row.className = `message-row message-${role}`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  // If assistant message has a delta comparison, render the Temporal Delta Card first
  if (role === 'assistant' && metadata && metadata.delta) {
    const delta = metadata.delta;
    const deltaCard = document.createElement('div');
    deltaCard.className = 'delta-card';

    const statusClass = (delta.status || '').toLowerCase();
    const statusLabel = delta.status === 'VERIFIED_CHANGE'
      ? 'Verified Updates Found'
      : delta.status === 'CONFIRMED_UNCHANGED'
      ? 'Confirmed Unchanged'
      : 'Inconclusive Evidence';

    deltaCard.innerHTML = `
      <div class="delta-header">
        <div class="delta-title">
          <span>⚖️ Temporal Fact-Check:</span>
          <strong>${escapeHtml(delta.entityOrTopic || 'Topic')}</strong>
        </div>
        <span class="delta-badge ${statusClass}">${statusLabel}</span>
      </div>
      <div class="delta-body">
        <div class="delta-row">
          <span class="delta-label">Historical:</span>
          <span class="delta-value">${escapeHtml(delta.historicalState.claim)}</span>
        </div>
        <div class="delta-row">
          <span class="delta-label">Current:</span>
          <span class="delta-value">${escapeHtml(delta.currentState.claim)}</span>
        </div>
        <div class="delta-row">
          <span class="delta-label">Verdict:</span>
          <span class="delta-value"><em>${escapeHtml(delta.explanation)}</em></span>
        </div>
      </div>
    `;
    bubble.appendChild(deltaCard);
  }

  // Text content
  const contentEl = document.createElement('div');
  contentEl.className = 'message-content';
  contentEl.innerHTML = formatMarkdown(content);
  bubble.appendChild(contentEl);

  // Render Citations drawer if present
  if (role === 'assistant' && metadata && metadata.citations && metadata.citations.length > 0) {
    const citationsContainer = document.createElement('div');
    citationsContainer.className = 'citations-container';

    let html = `<div class="citations-header">Sources & Evidence (${metadata.citations.length})</div><div class="citations-list">`;
    for (const c of metadata.citations) {
      html += `
        <a href="${escapeHtml(c.url)}" target="_blank" rel="noopener noreferrer" class="citation-pill">
          <span class="cite-idx">[${c.id}]</span>
          <span class="cite-title">${escapeHtml(c.title)}</span>
          ${c.publishedDate ? `<span class="cite-date">${escapeHtml(c.publishedDate)}</span>` : ''}
        </a>
      `;
    }
    html += `</div>`;
    citationsContainer.innerHTML = html;
    bubble.appendChild(citationsContainer);
  }

  row.appendChild(bubble);

  // Timestamp meta
  if (timestamp) {
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const timeStr = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    meta.textContent = `${role === 'user' ? 'You' : 'minimi'} • ${timeStr}`;
    row.appendChild(meta);
  }

  chatMessages.appendChild(row);
}

function renderLoadingIndicator() {
  const row = document.createElement('div');
  row.className = 'message-row message-assistant';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = `
    <div style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-secondary);">
      <span>Searching web & reasoning</span>
      <span class="loading-indicator">
        <span class="loading-dot"></span>
        <span class="loading-dot"></span>
        <span class="loading-dot"></span>
      </span>
    </div>
  `;
  row.appendChild(bubble);
  chatMessages.appendChild(row);
  return row;
}

function appendNotification(text) {
  const notice = document.createElement('div');
  notice.style.textAlign = 'center';
  notice.style.fontSize = '12px';
  notice.style.color = '#818cf8';
  notice.style.padding = '8px';
  notice.style.margin = '4px 0';
  notice.style.background = 'rgba(99, 102, 241, 0.1)';
  notice.style.borderRadius = '6px';
  notice.textContent = text;
  chatMessages.appendChild(notice);
  scrollToBottom();
}

function scrollToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatMarkdown(text) {
  if (!text) return '';
  let formatted = escapeHtml(text);

  // Bold
  formatted = formatted.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  // Italics
  formatted = formatted.replace(/\*(.*?)\*/g, '<em>$1</em>');
  // Headers
  formatted = formatted.replace(/^### (.*$)/gim, '<h4 style="margin: 10px 0 4px; color: #e0e7ff;">$1</h4>');
  // Bullet lists
  formatted = formatted.replace(/^\• (.*$)/gim, '<li style="margin-left: 18px;">$1</li>');
  formatted = formatted.replace(/^\- (.*$)/gim, '<li style="margin-left: 18px;">$1</li>');
  // Line breaks
  formatted = formatted.replace(/\n\n/g, '<br><br>');
  formatted = formatted.replace(/\n/g, '<br>');

  return formatted;
}
