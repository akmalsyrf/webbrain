/**
 * WebBrain Agent Visual Indicator (content script)
 *
 * Renders an animated purple inset glow around the page viewport while
 * the agent is operating on this tab, plus a "Stop WebBrain" floating
 * button at the bottom center. The same UI Anthropic's Claude-for-Chrome
 * extension uses while its agent is acting (see their bundled
 * agent-visual-indicator.js), recolored for WebBrain's accent (#6c63ff).
 *
 * Lifecycle messages from the service worker:
 *
 *   WB_SHOW_AGENT_INDICATORS  — agent run started → fade in border + button
 *   WB_HIDE_AGENT_INDICATORS  — agent run ended → fade out + remove
 *   WB_HIDE_FOR_TOOL_USE      — temporarily hide so screenshots don't
 *                                capture our own UI
 *   WB_SHOW_AFTER_TOOL_USE    — restore visibility after the screenshot
 *                                has been captured
 *
 * Stop button click → service worker via WB_STOP_AGENT, which calls
 * agent.abort(tabId) the same way the sidepanel's Stop button does.
 *
 * Self-contained — no imports, runs in the page's content-script world.
 * z-index uses the max signed 32-bit value so the indicator sits above
 * site overlays/modals but never accidentally swallows page input
 * (border has pointer-events: none; button uses pointer-events: auto).
 */

(function () {
  let borderEl = null;
  let stopContainerEl = null;
  let indicatorsActive = false;
  // Saved visibility state during HIDE_FOR_TOOL_USE so SHOW_AFTER_TOOL_USE
  // can restore the right thing (don't want to show indicators that
  // weren't on before the screenshot).
  let savedBorderVisible = false;
  let savedStopVisible = false;

  function injectStyles() {
    if (document.getElementById('webbrain-agent-styles')) return;
    const style = document.createElement('style');
    style.id = 'webbrain-agent-styles';
    style.textContent = `
      @keyframes webbrain-pulse {
        0% {
          box-shadow:
            inset 0 0 10px rgba(108, 99, 255, 0.5),
            inset 0 0 20px rgba(108, 99, 255, 0.3),
            inset 0 0 30px rgba(108, 99, 255, 0.1);
        }
        50% {
          box-shadow:
            inset 0 0 15px rgba(108, 99, 255, 0.7),
            inset 0 0 25px rgba(108, 99, 255, 0.5),
            inset 0 0 35px rgba(108, 99, 255, 0.2);
        }
        100% {
          box-shadow:
            inset 0 0 10px rgba(108, 99, 255, 0.5),
            inset 0 0 20px rgba(108, 99, 255, 0.3),
            inset 0 0 30px rgba(108, 99, 255, 0.1);
        }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function createBorder() {
    const el = document.createElement('div');
    el.id = 'webbrain-agent-glow-border';
    el.style.cssText = `
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      pointer-events: none;
      z-index: 2147483646;
      opacity: 0;
      transition: opacity 0.3s ease-in-out;
      animation: webbrain-pulse 2s ease-in-out infinite;
      box-shadow:
        inset 0 0 10px rgba(108, 99, 255, 0.5),
        inset 0 0 20px rgba(108, 99, 255, 0.3),
        inset 0 0 30px rgba(108, 99, 255, 0.1);
    `;
    return el;
  }

  function createStopButton() {
    const container = document.createElement('div');
    container.id = 'webbrain-agent-stop-container';
    container.style.cssText = `
      position: fixed;
      bottom: 16px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      justify-content: center;
      align-items: center;
      pointer-events: none;
      z-index: 2147483647;
    `;
    const button = document.createElement('button');
    button.id = 'webbrain-agent-stop-button';
    button.type = 'button';
    button.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 256 256" fill="currentColor"
           style="margin-right: 10px; vertical-align: middle;">
        <path d="M128,20A108,108,0,1,0,236,128,108.12,108.12,0,0,0,128,20Zm0,192a84,84,0,1,1,84-84A84.09,84.09,0,0,1,128,212Zm40-112v56a12,12,0,0,1-12,12H100a12,12,0,0,1-12-12V100a12,12,0,0,1,12-12h56A12,12,0,0,1,168,100Z"/>
      </svg>
      <span style="vertical-align: middle;">Stop WebBrain</span>
    `;
    button.style.cssText = `
      position: relative;
      transform: translateY(80px);
      padding: 11px 18px;
      background: #ffffff;
      color: #1a1a2e;
      border: 1px solid rgba(108, 99, 255, 0.30);
      border-radius: 12px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-shadow:
        0 24px 48px rgba(108, 99, 255, 0.24),
        0 4px 14px rgba(108, 99, 255, 0.20);
      transition:
        transform 0.3s cubic-bezier(0.4, 0, 0.2, 1),
        opacity 0.3s ease,
        background 0.15s ease;
      opacity: 0;
      user-select: none;
      pointer-events: auto;
      white-space: nowrap;
      margin: 0 auto;
    `;
    button.addEventListener('mouseenter', () => {
      if (indicatorsActive) button.style.background = '#f3f0ff';
    });
    button.addEventListener('mouseleave', () => {
      if (indicatorsActive) button.style.background = '#ffffff';
    });
    button.addEventListener('click', async () => {
      try {
        await browser.runtime.sendMessage({ type: 'WB_STOP_AGENT' });
      } catch { /* extension context invalidated, ignore */ }
    });
    container.appendChild(button);
    return container;
  }

  function show() {
    indicatorsActive = true;
    injectStyles();

    const root = document.body || document.documentElement;
    if (!root) return; // page hasn't parsed yet — extremely unlikely on document_idle

    if (borderEl) {
      borderEl.style.display = '';
    } else {
      borderEl = createBorder();
      root.appendChild(borderEl);
    }

    if (stopContainerEl) {
      stopContainerEl.style.display = '';
    } else {
      stopContainerEl = createStopButton();
      root.appendChild(stopContainerEl);
    }

    // Two RAFs: first to land the elements in the DOM (so the browser
    // computes their initial transforms with opacity 0 / translateY 80px),
    // second to apply the in-flight values for a clean transition.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (borderEl) borderEl.style.opacity = '1';
        const btn = stopContainerEl?.querySelector('#webbrain-agent-stop-button');
        if (btn) {
          btn.style.transform = 'translateY(0)';
          btn.style.opacity = '1';
        }
      });
    });
  }

  function hide() {
    if (!indicatorsActive) return;
    indicatorsActive = false;
    if (borderEl) borderEl.style.opacity = '0';
    const btn = stopContainerEl?.querySelector('#webbrain-agent-stop-button');
    if (btn) {
      btn.style.transform = 'translateY(80px)';
      btn.style.opacity = '0';
    }
    setTimeout(() => {
      // Bail if the user re-triggered show() during the fade-out.
      if (indicatorsActive) return;
      borderEl?.parentNode?.removeChild(borderEl);
      stopContainerEl?.parentNode?.removeChild(stopContainerEl);
      borderEl = null;
      stopContainerEl = null;
    }, 320);
  }

  /**
   * Hide both elements without tearing them down — for the brief window
   * around a screenshot capture, so the agent doesn't see its own border
   * pulsing in the screenshots it sends back to the model.
   */
  function hideForToolUse() {
    savedBorderVisible = !!(borderEl && borderEl.style.display !== 'none');
    savedStopVisible = !!(stopContainerEl && stopContainerEl.style.display !== 'none');
    if (borderEl) borderEl.style.display = 'none';
    if (stopContainerEl) stopContainerEl.style.display = 'none';
  }

  function showAfterToolUse() {
    if (savedBorderVisible && borderEl) borderEl.style.display = '';
    if (savedStopVisible && stopContainerEl) stopContainerEl.style.display = '';
    savedBorderVisible = false;
    savedStopVisible = false;
  }

  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'WB_SHOW_AGENT_INDICATORS':
        show();
        sendResponse({ ok: true });
        break;
      case 'WB_HIDE_AGENT_INDICATORS':
        hide();
        sendResponse({ ok: true });
        break;
      case 'WB_HIDE_FOR_TOOL_USE':
        hideForToolUse();
        sendResponse({ ok: true });
        break;
      case 'WB_SHOW_AFTER_TOOL_USE':
        showAfterToolUse();
        sendResponse({ ok: true });
        break;
      // Unknown messages are silently ignored — other content scripts in
      // the same world might be using browser.runtime.onMessage too.
    }
    // Synchronous response — return falsy so the channel closes.
  });
})();
