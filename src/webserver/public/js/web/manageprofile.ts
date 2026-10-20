declare global {
  interface Window {
    Notify: (type: string, message: string, time?: number) => void;
  }
}

const currentURL = new URL(window.location.href);
const resetEmail = currentURL.searchParams.get("email");
const resetCode = currentURL.searchParams.get("code");
const isResetMode = !!(resetEmail && resetCode);

function getToken(): string {
  const cookies = document.cookie.split(';');
  for (const cookie of cookies) {
    const [name, value] = cookie.trim().split('=');
    if (name === 'token') return value;
  }
  return '';
}

let totpEnabled = false;

function base64UrlToBuffer(base64url: string): ArrayBuffer {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4;
  const padded = pad ? base64 + '='.repeat(4 - pad) : base64;
  const raw = atob(padded);
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) {
    view[i] = raw.charCodeAt(i);
  }
  return buffer;
}

function bufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ========== Confirming a change ==========
// The server confirms each account change with the strongest second factor the
// account has set up. When it asks for one, use the security key or ask for the
// code, then send the request again with the answer.
type Confirmed = { ok: boolean; body: any; cancelled?: boolean };

function askForCode(title: string, desc: string): Promise<string | null> {
  const modal = document.getElementById('confirm-modal')!;
  const input = document.getElementById('confirm-code') as HTMLInputElement;
  const submit = document.getElementById('confirm-submit')!;
  const cancel = document.getElementById('confirm-cancel')!;
  document.getElementById('confirm-title')!.textContent = title;
  document.getElementById('confirm-desc')!.textContent = desc;
  input.value = '';
  modal.classList.remove('hidden');
  input.focus();

  return new Promise((resolve) => {
    const finish = (code: string | null) => {
      submit.removeEventListener('click', onSubmit);
      cancel.removeEventListener('click', onCancel);
      modal.classList.add('hidden');
      resolve(code);
    };
    const onSubmit = () => {
      const code = input.value.trim().toUpperCase();
      if (code.length !== 6) {
        window.Notify('error', 'Enter a valid 6-digit code');
        return;
      }
      finish(code);
    };
    const onCancel = () => finish(null);
    submit.addEventListener('click', onSubmit);
    cancel.addEventListener('click', onCancel);
  });
}

async function useSecurityKey(options: any): Promise<Record<string, string> | null> {
  if (!window.isSecureContext || !navigator?.credentials) {
    window.Notify('error', 'WebAuthn requires HTTPS or localhost');
    return null;
  }
  try {
    const credential = await navigator.credentials.get({
      publicKey: {
        challenge: base64UrlToBuffer(options.challenge),
        rpId: options.rpId,
        allowCredentials: options.allowCredentials.map((cred: any) => ({ type: 'public-key', id: base64UrlToBuffer(cred.id) })),
        timeout: options.timeout,
        userVerification: options.userVerification,
      },
    }) as PublicKeyCredential | null;
    if (!credential) return null;
    const response = credential.response as AuthenticatorAssertionResponse;
    return {
      credentialId: credential.id,
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      authenticatorData: bufferToBase64Url(response.authenticatorData),
      signature: bufferToBase64Url(response.signature),
    };
  } catch (err: any) {
    if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
      window.Notify('error', err.message || 'Verification failed');
    }
    return null;
  }
}

async function postConfirmed(url: string, payload: Record<string, any>, signedIn = true): Promise<Confirmed> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (signedIn) headers['Authorization'] = `Bearer ${getToken()}`;
  const send = async (): Promise<Confirmed> => {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    return { ok: response.ok, body: await response.json() };
  };

  const result = await send();
  if (!result.ok) return result;

  if (result.body.requiresWebAuthn) {
    const answer = await useSecurityKey(result.body.options);
    if (!answer) return { ok: false, body: result.body, cancelled: true };
    payload.webauthnResponse = answer;
  } else if (result.body.requiresTotp) {
    const code = await askForCode('Authenticator Code', 'Enter the code from your authenticator app to confirm.');
    if (!code) return { ok: false, body: result.body, cancelled: true };
    payload.totp = code;
  } else if (result.body.requiresEmail) {
    const code = await askForCode('Email Verification', 'A verification code was sent to your email. Enter it to confirm.');
    if (!code) return { ok: false, body: result.body, cancelled: true };
    payload.emailCode = code;
  } else {
    return result;
  }
  return send();
}

function reportFailure(result: Confirmed) {
  if (!result.cancelled) window.Notify('error', result.body.message || 'Something went wrong');
}

async function loadProfile() {
  // A reset link shows the reset form, even in a browser that is still signed in.
  if (isResetMode) {
    initResetMode();
    return;
  }

  const token = getToken();
  if (!token) {
    window.location.href = '/';
    return;
  }

  try {
    const response = await fetch('/api/profile', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (response.status === 401) {
      window.location.href = '/';
      return;
    }
    if (response.status === 403) {
      const body = await response.json();
      window.location.href = body.redirect || '/2fa-challenge';
      return;
    }
    const profile = await response.json();

    const loadingEl = document.getElementById('profile-loading');
    const contentEl = document.getElementById('profile-content');
    if (loadingEl) loadingEl.classList.add('hidden');
    if (contentEl) contentEl.classList.remove('hidden');

    document.getElementById('profile-username')!.textContent = profile.username;
    profileEmailMasked = profile.email_masked || '********';
    document.getElementById('profile-email')!.textContent = profileEmailMasked;
    document.getElementById('profile-lastlogin')!.textContent = profile.last_login ? new Date(profile.last_login).toLocaleString() : 'Never';

    (document.getElementById('require-webauthn') as HTMLInputElement).checked = profile.require_webauthn;
    (document.getElementById('require-totp') as HTMLInputElement).checked = profile.require_totp;
    (document.getElementById('require-email') as HTMLInputElement).checked = profile.require_email_2fa;

    updateCheckboxStates(profile);

    updateSecurityBanner();

    totpEnabled = profile.totp_enabled;

    const totpBadge = document.getElementById('totp-badge')!;
    const totpEnableBtn = document.getElementById('totp-enable-btn')!;
    const totpDisableBtn = document.getElementById('totp-disable-btn')!;
    if (profile.totp_enabled) {
      totpBadge.textContent = 'Enabled';
      totpBadge.className = 'badge badge-on';
      totpEnableBtn.classList.add('hidden');
      totpDisableBtn.classList.remove('hidden');
    } else {
      totpBadge.textContent = 'Disabled';
      totpBadge.className = 'badge badge-off';
      totpEnableBtn.classList.remove('hidden');
      totpDisableBtn.classList.add('hidden');
    }

    const webauthnBadge = document.getElementById('webauthn-badge')!;
    const webauthnKeys = profile.webauthn_credentials || [];
    if (webauthnKeys.length > 0) {
      webauthnBadge.textContent = `${webauthnKeys.length} key${webauthnKeys.length > 1 ? 's' : ''}`;
      webauthnBadge.className = 'badge badge-on';
    } else {
      webauthnBadge.textContent = 'No keys';
      webauthnBadge.className = 'badge badge-off';
    }

    renderWebAuthnKeys(webauthnKeys);
    void loadSubscription();
  } catch {
    window.Notify('error', 'Failed to load profile');
  }
}

function initResetMode() {
  document.getElementById('profile-loading')!.classList.add('hidden');
  document.getElementById('reset-password-section')!.classList.remove('hidden');
  document.getElementById('reset-email-display')!.textContent = resetEmail!;
}

function renderWebAuthnKeys(keys: Array<{ id: string; name: string; createdAt: string }>) {
  const listEl = document.getElementById('webauthn-keys-list')!;
  listEl.innerHTML = '';

  if (keys.length === 0) {
    listEl.innerHTML = '<div class="empty-note">No security keys registered</div>';
    return;
  }

  for (const key of keys) {
    const div = document.createElement('div');
    div.className = 'key-item';
    div.innerHTML = `
      <div>
        <div class="key-label">${key.name}</div>
        <div class="key-meta">Added ${new Date(key.createdAt).toLocaleDateString()}</div>
      </div>
      <button class="btn-outline btn-outline-danger remove-key-btn" data-key-id="${key.id}">Remove</button>
    `;
    listEl.appendChild(div);
  }

  document.querySelectorAll('.remove-key-btn').forEach((btn) => {
    btn.addEventListener('click', async function (this: HTMLElement) {
      const keyId = this.dataset.keyId!;
      const keyName = this.closest('.key-item')?.querySelector('.key-label')?.textContent || 'this key';
      showRemoveKeyModal(keyId, keyName);
    });
  });
}

// ========== Reset Password (email link flow) ==========
document.getElementById('reset-generate-password-btn')?.addEventListener('click', async () => {
  try {
    const password = await generatePasswordFromServer();
    (document.getElementById('reset-new-password') as HTMLInputElement).value = password;
    (document.getElementById('reset-confirm-password') as HTMLInputElement).value = password;
    document.getElementById('reset-new-password')?.focus();
    window.Notify('success', 'Secure password generated');
  } catch {
    window.Notify('error', 'Failed to generate password');
  }
});

document.getElementById('reset-password-btn')?.addEventListener('click', async () => {
  const password = (document.getElementById('reset-new-password') as HTMLInputElement).value;
  const confirm = (document.getElementById('reset-confirm-password') as HTMLInputElement).value;

  if (!password || !confirm) {
    window.Notify('error', 'All fields are required');
    return;
  }
  if (password !== confirm) {
    window.Notify('error', 'Passwords do not match');
    return;
  }

  const result = await postConfirmed('/update-password', {
    email: resetEmail!,
    password,
    password2: confirm,
    code: resetCode!,
  }, false);

  if (result.ok) {
    window.Notify('success', 'Password updated. Redirecting to login...');
    setTimeout(() => { window.location.href = '/'; }, 3000);
  } else {
    reportFailure(result);
  }
});

// ========== Change Email ==========
let pendingNewEmail = '';
let emailChangePassword = '';
let emailChangeStep: 'old' | 'new' = 'old';

document.getElementById('change-email-btn')?.addEventListener('click', () => {
  const newEmail = (document.getElementById('new-email') as HTMLInputElement).value.trim();
  if (!newEmail) {
    window.Notify('error', 'Email is required');
    return;
  }
  pendingNewEmail = newEmail;
  emailChangePassword = '';
  emailChangeStep = 'old';

  showEmailChangeModal('password');
});

function showEmailChangeModal(step: 'password' | 'code') {
  document.getElementById('email-2fa-password')!.classList.add('hidden');
  document.getElementById('email-2fa-code')!.classList.add('hidden');
  (document.getElementById('email-2fa-password-input') as HTMLInputElement).value = '';
  (document.getElementById('email-2fa-code-input') as HTMLInputElement).value = '';

  if (step === 'password') {
    document.getElementById('email-2fa-title')!.textContent = 'Confirm Password';
    document.getElementById('email-2fa-desc')!.textContent = 'Enter your account password to change your email.';
    document.getElementById('email-2fa-password')!.classList.remove('hidden');
    (document.getElementById('email-2fa-password-input') as HTMLInputElement).focus();
  } else {
    document.getElementById('email-2fa-code')!.classList.remove('hidden');
    (document.getElementById('email-2fa-code-input') as HTMLInputElement).focus();
  }

  document.getElementById('email-2fa-modal')!.classList.remove('hidden');
}

document.getElementById('email-2fa-cancel')?.addEventListener('click', () => {
  document.getElementById('email-2fa-modal')!.classList.add('hidden');
  pendingNewEmail = '';
  emailChangePassword = '';
  emailChangeStep = 'old';
});

document.getElementById('email-2fa-submit')?.addEventListener('click', async () => {
  const passwordVisible = !document.getElementById('email-2fa-password')!.classList.contains('hidden');
  const codeVisible = !document.getElementById('email-2fa-code')!.classList.contains('hidden');

  if (passwordVisible) {
    const pwd = (document.getElementById('email-2fa-password-input') as HTMLInputElement).value;
    if (!pwd) {
      window.Notify('error', 'Password is required');
      return;
    }
    emailChangePassword = pwd;
    sendEmailChangeRequest();
    return;
  }

  if (codeVisible) {
    const code = (document.getElementById('email-2fa-code-input') as HTMLInputElement).value.trim().toUpperCase();
    if (!code || code.length !== 6) {
      window.Notify('error', 'Enter a valid 6-digit code');
      return;
    }

    const token = getToken();
    const requestBody: Record<string, string> = { email: pendingNewEmail, password: emailChangePassword };

    if (emailChangeStep === 'old') {
      requestBody.oldEmailCode = code;
    } else {
      requestBody.emailCode = code;
    }

    const response = await fetch('/api/profile/change-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(requestBody),
    });

    const body = await response.json();
    if (!response.ok) {
      window.Notify('error', body.message);
      return;
    }

    if (body.requiresNewCode) {
      emailChangeStep = 'new';
      document.getElementById('email-2fa-title')!.textContent = 'Verify New Email';
      document.getElementById('email-2fa-desc')!.textContent = `A verification code was sent to ${pendingNewEmail}. Enter it to confirm.`;
      (document.getElementById('email-2fa-code-input') as HTMLInputElement).value = '';
      document.getElementById('email-2fa-code-input')?.focus();
      return;
    }

    document.getElementById('email-2fa-modal')!.classList.add('hidden');
    window.Notify('success', body.message);
    revealedEmail = '';
    showingRevealed = false;
    profileEmailMasked = body.email_masked || pendingNewEmail;
    document.getElementById('profile-email')!.textContent = profileEmailMasked;
    (document.getElementById('new-email') as HTMLInputElement).value = '';
    pendingNewEmail = '';
    emailChangePassword = '';
  }
});

async function sendEmailChangeRequest() {
  const result = await postConfirmed('/api/profile/change-email', { email: pendingNewEmail, password: emailChangePassword });
  if (!result.ok) {
    document.getElementById('email-2fa-modal')!.classList.add('hidden');
    reportFailure(result);
    return;
  }

  emailChangeStep = 'old';
  document.getElementById('email-2fa-title')!.textContent = 'Verify Current Email';
  document.getElementById('email-2fa-desc')!.textContent = `A verification code was sent to ${result.body.oldEmailMasked}. Enter it to continue.`;
  showEmailChangeModal('code');
}

// ========== Change Password ==========
async function generatePasswordFromServer(): Promise<string> {
  const token = getToken();
  const response = await fetch('/api/profile/generate-password', {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const body = await response.json();
  return body.password;
}

document.getElementById('generate-password-btn')?.addEventListener('click', async () => {
  try {
    const password = await generatePasswordFromServer();
    (document.getElementById('new-password') as HTMLInputElement).value = password;
    (document.getElementById('confirm-password') as HTMLInputElement).value = password;
    document.getElementById('new-password')?.focus();
    window.Notify('success', 'Secure password generated');
  } catch {
    window.Notify('error', 'Failed to generate password');
  }
});

document.getElementById('change-password-btn')?.addEventListener('click', async () => {
  const currentPassword = (document.getElementById('current-password') as HTMLInputElement).value;
  const newPassword = (document.getElementById('new-password') as HTMLInputElement).value;
  const confirmPassword = (document.getElementById('confirm-password') as HTMLInputElement).value;

  if (!currentPassword || !newPassword || !confirmPassword) {
    window.Notify('error', 'All fields are required');
    return;
  }
  if (newPassword !== confirmPassword) {
    window.Notify('error', 'Passwords do not match');
    return;
  }

  const result = await postConfirmed('/api/profile/change-password', { currentPassword, newPassword });
  if (result.ok) {
    clearPasswordFields();
    window.Notify('success', result.body.message);
  } else {
    reportFailure(result);
  }
});

function clearPasswordFields() {
  (document.getElementById('current-password') as HTMLInputElement).value = '';
  (document.getElementById('new-password') as HTMLInputElement).value = '';
  (document.getElementById('confirm-password') as HTMLInputElement).value = '';
}

// ========== 2FA Requirements Toggle ==========
let isUpdatingCheckbox = false;

document.querySelectorAll('input[data-method]').forEach((cb) => {
  cb.addEventListener('change', async function (this: HTMLInputElement) {
    if (isUpdatingCheckbox) return;
    const method = this.dataset.method!;
    const value = this.checked;

    // The switch shows the saved state until the server confirms the change.
    isUpdatingCheckbox = true;
    this.checked = !value;
    isUpdatingCheckbox = false;

    const result = await postConfirmed('/api/profile/2fa-requirements', { method, value });
    if (!result.ok) {
      reportFailure(result);
      return;
    }

    updateAllCheckboxes(result.body);
    const labels: Record<string, string> = {
      webauthn: 'Security Key will be required for sign-in',
      totp: 'Authenticator App will be required for sign-in',
      email: 'Email verification will be required for sign-in',
    };
    window.Notify('success', value ? labels[method] || 'Method enabled' : 'Requirement disabled');
  });
});

function updateAllCheckboxes(body: any) {
  isUpdatingCheckbox = true;
  (document.getElementById('require-webauthn') as HTMLInputElement).checked = body.requireWebAuthn;
  (document.getElementById('require-totp') as HTMLInputElement).checked = body.requireTotp;
  (document.getElementById('require-email') as HTMLInputElement).checked = body.requireEmail2FA;
  isUpdatingCheckbox = false;
  updateSecurityBanner();
}

function updateCheckboxStates(profile?: any) {
  const cbWebAuthn = document.getElementById('require-webauthn') as HTMLInputElement;
  const cbTotp = document.getElementById('require-totp') as HTMLInputElement;
  const cbEmail = document.getElementById('require-email') as HTMLInputElement;

  if (profile) {
    const webauthnKeys = profile.webauthn_credentials || [];
    cbWebAuthn.disabled = webauthnKeys.length === 0;
    cbTotp.disabled = !profile.totp_enabled;
    cbEmail.disabled = false;
  } else {
    cbWebAuthn.disabled = document.querySelectorAll('.key-item').length === 0;
    cbTotp.disabled = !totpEnabled;
    cbEmail.disabled = false;
  }
}

function updateSecurityBanner() {
  const banner = document.getElementById('security-banner')!;
  const anyEnabled = (document.getElementById('require-webauthn') as HTMLInputElement).checked
    || (document.getElementById('require-totp') as HTMLInputElement).checked
    || (document.getElementById('require-email') as HTMLInputElement).checked;
  if (anyEnabled) {
    banner.classList.add('hidden');
  } else {
    banner.classList.remove('hidden');
  }
}

// ========== TOTP ==========
document.getElementById('totp-enable-btn')?.addEventListener('click', () => {
  document.getElementById('totp-setup-password')!.classList.remove('hidden');
  document.getElementById('totp-setup-qr')!.classList.add('hidden');
  (document.getElementById('totp-setup-password-input') as HTMLInputElement).value = '';
  document.getElementById('totp-setup-modal')!.classList.remove('hidden');
  document.getElementById('totp-setup-password-input')?.focus();
});

document.getElementById('totp-setup-cancel-btn')?.addEventListener('click', () => {
  document.getElementById('totp-setup-modal')!.classList.add('hidden');
});

document.getElementById('totp-qr-cancel-btn')?.addEventListener('click', () => {
  document.getElementById('totp-setup-modal')!.classList.add('hidden');
});

document.getElementById('totp-setup-password-btn')?.addEventListener('click', async () => {
  const password = (document.getElementById('totp-setup-password-input') as HTMLInputElement).value;
  if (!password) {
    window.Notify('error', 'Password is required');
    return;
  }

  const result = await postConfirmed('/api/profile/setup-totp', { password });
  if (result.ok) {
    document.getElementById('totp-setup-password')!.classList.add('hidden');
    document.getElementById('totp-setup-qr')!.classList.remove('hidden');
    const qrImg = document.getElementById('totp-qr') as HTMLImageElement;
    qrImg.style.visibility = 'hidden';
    qrImg.onload = () => { qrImg.style.visibility = 'visible'; };
    qrImg.src = result.body.qrUrl;
    (document.getElementById('totp-code') as HTMLInputElement).value = '';
    document.getElementById('totp-code')?.focus();
  } else {
    reportFailure(result);
  }
});

document.getElementById('totp-verify-btn')?.addEventListener('click', async () => {
  const code = (document.getElementById('totp-code') as HTMLInputElement).value.toUpperCase();
  if (!code || code.length !== 6) {
    window.Notify('error', 'Enter a valid 6-digit code');
    return;
  }

  const token = getToken();
  const response = await fetch('/api/profile/verify-totp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ code }),
  });

  const body = await response.json();
  if (response.ok) {
    document.getElementById('totp-setup-modal')!.classList.add('hidden');
    window.Notify('success', 'Authenticator app enabled');
    document.getElementById('totp-badge')!.textContent = 'Enabled';
    document.getElementById('totp-badge')!.className = 'badge badge-on';
    document.getElementById('totp-enable-btn')!.classList.add('hidden');
    document.getElementById('totp-disable-btn')!.classList.remove('hidden');
    totpEnabled = true;
    updateCheckboxStates();
  } else {
    window.Notify('error', body.message);
  }
});

document.getElementById('totp-disable-btn')?.addEventListener('click', () => {
  (document.getElementById('totp-remove-password') as HTMLInputElement).value = '';
  document.getElementById('totp-remove-message')!.textContent = '';
  document.getElementById('totp-remove-message')!.className = '';
  document.getElementById('totp-remove-modal')!.classList.remove('hidden');
  document.getElementById('totp-remove-password')?.focus();
});

document.getElementById('totp-remove-cancel')?.addEventListener('click', () => {
  document.getElementById('totp-remove-modal')!.classList.add('hidden');
});

document.getElementById('totp-remove-submit')?.addEventListener('click', async () => {
  const password = (document.getElementById('totp-remove-password') as HTMLInputElement).value;
  if (!password) {
    window.Notify('error', 'Password is required');
    return;
  }

  const result = await postConfirmed('/api/profile/disable-totp', { password });
  if (!result.ok) {
    reportFailure(result);
    return;
  }

  document.getElementById('totp-remove-modal')!.classList.add('hidden');
  window.Notify('success', result.body.message);
  document.getElementById('totp-badge')!.textContent = 'Disabled';
  document.getElementById('totp-badge')!.className = 'badge badge-off';
  document.getElementById('totp-enable-btn')!.classList.remove('hidden');
  document.getElementById('totp-disable-btn')!.classList.add('hidden');
  totpEnabled = false;
  isUpdatingCheckbox = true;
  (document.getElementById('require-totp') as HTMLInputElement).checked = false;
  isUpdatingCheckbox = false;
  updateCheckboxStates();
  updateSecurityBanner();
});

// ========== WebAuthn ==========
// The registration options the server gives once the change is confirmed.
let pendingRegistrationOptions: any = null;

document.getElementById('webauthn-add-btn')?.addEventListener('click', () => {
  pendingRegistrationOptions = null;
  document.getElementById('webauthn-password-step')!.classList.remove('hidden');
  document.getElementById('webauthn-name-step')!.classList.add('hidden');
  (document.getElementById('webauthn-password') as HTMLInputElement).value = '';
  document.getElementById('webauthn-key-modal')!.classList.remove('hidden');
  document.getElementById('webauthn-password')?.focus();
});

document.getElementById('webauthn-cancel-btn')?.addEventListener('click', () => {
  document.getElementById('webauthn-key-modal')!.classList.add('hidden');
});

document.getElementById('webauthn-name-cancel-btn')?.addEventListener('click', () => {
  document.getElementById('webauthn-key-modal')!.classList.add('hidden');
});

document.getElementById('webauthn-password-btn')?.addEventListener('click', async () => {
  const password = (document.getElementById('webauthn-password') as HTMLInputElement).value;
  if (!password) {
    window.Notify('error', 'Password is required');
    return;
  }

  const result = await postConfirmed('/api/profile/register-webauthn', { password });
  if (result.ok) {
    pendingRegistrationOptions = result.body;
    document.getElementById('webauthn-password-step')!.classList.add('hidden');
    document.getElementById('webauthn-name-step')!.classList.remove('hidden');
    (document.getElementById('webauthn-key-name') as HTMLInputElement).value = '';
    document.getElementById('webauthn-key-name')?.focus();
  } else {
    reportFailure(result);
  }
});

document.getElementById('webauthn-register-btn')?.addEventListener('click', async () => {
  const keyName = (document.getElementById('webauthn-key-name') as HTMLInputElement).value || 'Security Key';
  const token = getToken();

  if (!window.isSecureContext || !navigator?.credentials) {
    window.Notify('error', 'WebAuthn requires HTTPS or localhost');
    return;
  }

  const options = pendingRegistrationOptions;
  if (!options) return;
  pendingRegistrationOptions = null;

  try {
    const publicKey: PublicKeyCredentialCreationOptions = {
      challenge: base64UrlToBuffer(options.challenge),
      rp: options.rp,
      user: {
        id: base64UrlToBuffer(options.user.id),
        name: options.user.name,
        displayName: options.user.displayName,
      },
      pubKeyCredParams: options.pubKeyCredParams,
      timeout: options.timeout,
      attestation: options.attestation,
      authenticatorSelection: options.authenticatorSelection,
    };

    if (options.excludeCredentials && options.excludeCredentials.length > 0) {
      publicKey.excludeCredentials = options.excludeCredentials.map((cred: any) => ({
        type: 'public-key',
        id: base64UrlToBuffer(cred.id),
      }));
    }

    const credential = await navigator.credentials.create({ publicKey }) as PublicKeyCredential;
    if (!credential) throw new Error('Failed to create credential');

    const credResponse = credential.response as AuthenticatorAttestationResponse;

    const verifyResponse = await fetch('/api/profile/verify-webauthn-registration', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        keyName,
        credentialId: credential.id,
        clientDataJSON: bufferToBase64Url(credResponse.clientDataJSON),
        attestationObject: bufferToBase64Url(credResponse.attestationObject),
      }),
    });

    const verifyBody = await verifyResponse.json();
    if (verifyResponse.ok) {
      window.Notify('success', 'Security key registered');
      document.getElementById('webauthn-key-modal')!.classList.add('hidden');
      (document.getElementById('webauthn-key-name') as HTMLInputElement).value = '';

      const keys = verifyBody.credentials || [];
      renderWebAuthnKeys(keys);
      updateWebAuthnBadge(keys.length);
      updateCheckboxStates();
    } else {
      window.Notify('error', verifyBody.message);
    }
  } catch (err: any) {
    if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
      window.Notify('error', err.message || 'WebAuthn registration failed');
    }
    document.getElementById('webauthn-key-modal')!.classList.add('hidden');
  }
});

let pendingRemoveKeyId = '';

function showRemoveKeyModal(keyId: string, keyName: string) {
  pendingRemoveKeyId = keyId;
  document.getElementById('remove-key-desc')!.textContent = `Enter your password to remove "${keyName}".`;
  (document.getElementById('remove-key-password') as HTMLInputElement).value = '';
  document.getElementById('remove-key-message')!.textContent = '';
  document.getElementById('remove-key-message')!.className = '';

  document.getElementById('remove-key-modal')!.classList.remove('hidden');
  document.getElementById('remove-key-password')?.focus();
}

document.getElementById('remove-key-cancel')?.addEventListener('click', () => {
  document.getElementById('remove-key-modal')!.classList.add('hidden');
  pendingRemoveKeyId = '';
});

document.getElementById('remove-key-submit')?.addEventListener('click', async () => {
  const password = (document.getElementById('remove-key-password') as HTMLInputElement).value;
  if (!password) {
    window.Notify('error', 'Password is required');
    return;
  }

  const result = await postConfirmed('/api/profile/remove-webauthn', { credentialId: pendingRemoveKeyId, password });
  if (!result.ok) {
    reportFailure(result);
    return;
  }

  document.getElementById('remove-key-modal')!.classList.add('hidden');
  const keys = result.body.credentials || [];
  renderWebAuthnKeys(keys);
  updateWebAuthnBadge(keys.length);
  updateAllCheckboxes(result.body);
  updateCheckboxStates();
  window.Notify('success', 'Security key removed');
  pendingRemoveKeyId = '';
});

function updateWebAuthnBadge(count: number) {
  const badge = document.getElementById('webauthn-badge')!;
  if (count > 0) {
    badge.textContent = `${count} key${count > 1 ? 's' : ''}`;
    badge.className = 'badge badge-on';
  } else {
    badge.textContent = 'No keys';
    badge.className = 'badge badge-off';
  }
}

// ========== Reveal Email ==========
let revealedEmail = '';
let showingRevealed = false;

function showRevealedEmail() {
  document.getElementById('profile-email')!.textContent = revealedEmail;
  showingRevealed = true;
}

function showMaskedEmail() {
  document.getElementById('profile-email')!.textContent = profileEmailMasked || '********';
  showingRevealed = false;
}

document.getElementById('reveal-email-btn')?.addEventListener('click', () => {
  if (revealedEmail) {
    if (showingRevealed) {
      showMaskedEmail();
    } else {
      showRevealedEmail();
    }
    return;
  }
  document.getElementById('reveal-email-modal')!.classList.remove('hidden');
  (document.getElementById('reveal-password') as HTMLInputElement).value = '';
  document.getElementById('reveal-password')?.focus();
});

document.getElementById('reveal-email-cancel')?.addEventListener('click', () => {
  document.getElementById('reveal-email-modal')!.classList.add('hidden');
  (document.getElementById('reveal-password') as HTMLInputElement).value = '';
});

document.getElementById('reveal-email-submit')?.addEventListener('click', async () => {
  const password = (document.getElementById('reveal-password') as HTMLInputElement).value;
  if (!password) {
    window.Notify('error', 'Password is required');
    return;
  }

  const token = getToken();
  const response = await fetch('/api/profile/reveal-email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ password }),
  });

  const body = await response.json();
  if (response.ok) {
    revealedEmail = body.email;
    showRevealedEmail();
    document.getElementById('reveal-email-modal')!.classList.add('hidden');
    (document.getElementById('reveal-password') as HTMLInputElement).value = '';
  } else {
    window.Notify('error', body.message);
  }
});

document.getElementById('reveal-email-modal')?.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).id === 'reveal-email-modal') {
    document.getElementById('reveal-email-modal')!.classList.add('hidden');
    (document.getElementById('reveal-password') as HTMLInputElement).value = '';
  }
});

// ========== Subscription ==========
interface SubscriptionInfo {
  enabled: boolean;
  subscribed: boolean;
  ends: number | null;
  loginLocked: boolean;
  guest: boolean;
}

async function fetchSubscription(): Promise<SubscriptionInfo | null> {
  try {
    const response = await fetch('/api/subscription', {
      headers: { 'Authorization': `Bearer ${getToken()}` },
      cache: 'no-store',
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function renderSubscription(info: SubscriptionInfo) {
  // Drawn only for a signed-in account of a game that charges.
  document.getElementById('subscription-grid')!.classList.toggle('hidden', !info.enabled || info.guest);

  const badge = document.getElementById('subscription-badge')!;
  badge.textContent = info.subscribed ? 'Subscribed' : 'Not subscribed';
  badge.className = info.subscribed ? 'badge badge-on' : 'badge badge-off';
  document.getElementById('subscribe-btn')!.classList.toggle('hidden', info.subscribed);
  document.getElementById('manage-subscription-btn')!.classList.toggle('hidden', !info.subscribed);

  const ends = document.getElementById('subscription-ends')!;
  ends.textContent = info.subscribed && info.ends ? `Until ${new Date(info.ends).toLocaleDateString()}` : '';
  ends.classList.toggle('hidden', !(info.subscribed && info.ends));
}

async function loadSubscription() {
  const info = await fetchSubscription();
  if (!info) return;
  renderSubscription(info);

  // Back from Stripe: the webhook can arrive a moment after the browser does.
  if (new URL(window.location.href).searchParams.get('subscription') === 'success') {
    window.history.replaceState(null, '', '/manage-profile');
    let current = info;
    for (let attempt = 0; attempt < 10 && !current.subscribed; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      current = (await fetchSubscription()) || current;
    }
    renderSubscription(current);
    if (current.subscribed) window.Notify('success', 'Subscribed');
  }
}

async function openSubscriptionPage(path: string, button: HTMLButtonElement) {
  button.disabled = true;
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
      body: '{}',
    });
    const body = await response.json();
    if (response.ok && body.url) {
      window.location.href = body.url;
      return;
    }
    window.Notify('error', body.message || 'Something went wrong');
  } catch {
    window.Notify('error', 'Something went wrong');
  }
  button.disabled = false;
}

document.getElementById('subscribe-btn')?.addEventListener('click', (e) => {
  openSubscriptionPage('/api/subscription/checkout', e.currentTarget as HTMLButtonElement);
});

document.getElementById('manage-subscription-btn')?.addEventListener('click', (e) => {
  openSubscriptionPage('/api/subscription/portal', e.currentTarget as HTMLButtonElement);
});

let profileEmailMasked = '';

window.addEventListener('DOMContentLoaded', loadProfile);
