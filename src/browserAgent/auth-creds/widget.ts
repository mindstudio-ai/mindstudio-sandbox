/**
 * Shadow-DOM widget that explains dev-mode auth and offers one-click
 * autofill + submit of the hardcoded test credentials.
 *
 * Pure presentation — detection lives in `auth-creds/index.ts`. The widget
 * just renders what it's handed.
 */

import type { OtpTarget } from './detect';
import { getState } from '../state';
import { fillAndSubmit, fillOtp } from './fill';

const HOST_ID = '__mindstudio-auth-creds-host';

export const DEV_EMAIL = 'remy@mindstudio.ai';
export const DEV_PHONE = '+15555555555';
export const DEV_OTP_CODE = '123456';

export interface WidgetState {
  identifier: HTMLInputElement | null;
  identifierKind: 'email' | 'phone' | null;
  code: OtpTarget | null;
  loading: boolean;
  onDismiss: () => void;
  onIdentifierFilled: () => void;
}

export function showOrUpdateWidget(state: WidgetState): void {
  const s = getState().authCredsWidget;
  if (!s.host) {
    mount();
  }
  render(state);
}

export function hideWidget(): void {
  const s = getState().authCredsWidget;
  if (!s.host) {
    return;
  }
  s.host.remove();
  s.host = null;
}

function mount(): void {
  const s = getState().authCredsWidget;

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText =
    'position: fixed; right: 16px; bottom: 16px; z-index: 2147483640; pointer-events: none;';
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    .card {
      pointer-events: auto;
      width: 280px;
      background: #0a0a0a;
      color: #fff;
      border: 1px solid #262626;
      border-radius: 8px;
      padding: 12px 14px 14px;
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      font-size: 12px;
      line-height: 1.45;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.4);
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin: 0 0 6px;
    }
    .title {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #888;
    }
    .dismiss {
      background: none;
      border: none;
      color: #666;
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      padding: 0 2px;
      margin: -2px -4px -2px 0;
      font-family: inherit;
    }
    .dismiss:hover { color: #ccc; }
    .body {
      margin: 0 0 10px;
      color: #b4b4b4;
    }
    .actions {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    button.primary {
      width: 100%;
      font-family: inherit;
      font-size: 12px;
      font-weight: 500;
      line-height: 1.3;
      padding: 9px 12px;
      border-radius: 6px;
      border: 1px solid #fff;
      background: #fff;
      color: #000;
      cursor: pointer;
      text-align: center;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    button.primary:hover {
      background: #e5e5e5;
      border-color: #e5e5e5;
    }
    .loading {
      display: flex;
      align-items: center;
      gap: 8px;
      color: #d4d4d4;
      padding: 2px 0 2px;
    }
    .spinner {
      width: 12px;
      height: 12px;
      border: 1.5px solid #2a2a2a;
      border-top-color: #fff;
      border-radius: 50%;
      animation: __ms_auth_spin 0.8s linear infinite;
      flex-shrink: 0;
    }
    @keyframes __ms_auth_spin {
      to { transform: rotate(360deg); }
    }
  `;
  shadow.appendChild(style);

  const card = document.createElement('div');
  card.className = 'card';
  shadow.appendChild(card);

  document.body.appendChild(host);
  s.host = host;
}

function render(state: WidgetState): void {
  const s = getState().authCredsWidget;
  if (!s.host) {
    return;
  }
  const shadow = s.host.shadowRoot;
  if (!shadow) {
    return;
  }
  const card = shadow.querySelector<HTMLDivElement>('.card');
  if (!card) {
    return;
  }

  // Idempotent loading: while the auto-chain polls (every CODE_POLL_MS) and on
  // every DOM mutation it churns (the resend countdown ticking, the caret
  // blink), evaluate() re-renders with the same loading state. Rebuilding the
  // card each time restarts the spinner's CSS animation from frame 0, which
  // reads as a flicker. If the loading UI is already up, leave it untouched.
  if (state.loading && card.querySelector('.loading')) {
    return;
  }

  card.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'header';
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = 'Dev mode';
  const dismiss = document.createElement('button');
  dismiss.className = 'dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.title = 'Dismiss';
  dismiss.textContent = '×';
  dismiss.addEventListener('click', state.onDismiss);
  header.appendChild(title);
  header.appendChild(dismiss);
  card.appendChild(header);

  if (state.loading) {
    const loading = document.createElement('div');
    loading.className = 'loading';
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    const label = document.createElement('span');
    label.textContent = 'Signing in…';
    loading.appendChild(spinner);
    loading.appendChild(label);
    card.appendChild(loading);
    return;
  }

  const body = document.createElement('p');
  body.className = 'body';
  body.textContent =
    'Use your own credentials, or use these test credentials to bypass verification.';
  card.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'actions';
  card.appendChild(actions);

  if (state.identifier && state.identifierKind) {
    const value = state.identifierKind === 'email' ? DEV_EMAIL : DEV_PHONE;
    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = `Continue with ${value}`;
    btn.title = `Continue with ${value}`;
    btn.addEventListener('click', () => {
      if (state.identifier) {
        fillAndSubmit(state.identifier, value);
        state.onIdentifierFilled();
      }
    });
    actions.appendChild(btn);
  }

  if (state.code) {
    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = `Continue with ${DEV_OTP_CODE}`;
    btn.title = `Continue with ${DEV_OTP_CODE}`;
    btn.addEventListener('click', () => {
      if (state.code) {
        fillOtp(state.code, DEV_OTP_CODE);
      }
    });
    actions.appendChild(btn);
  }
}
