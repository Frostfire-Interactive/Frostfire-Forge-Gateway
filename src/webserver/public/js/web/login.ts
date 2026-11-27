const login = document.getElementById('login-button');
const guestLogin = document.getElementById('guest-login-link') as HTMLAnchorElement;
const username = document.getElementById('username') as HTMLInputElement;
const password = document.getElementById('password') as HTMLInputElement;
const passwordForm = document.getElementById('password-form-group') as HTMLFormElement;
// Desktop only: focusing on load pops the keyboard open on mobile.
if (!('ontouchstart' in window) && navigator.maxTouchPoints <= 0) {
  username.focus();
}
if (!login) {
  throw new Error('login-button not found');
}

if (new URLSearchParams(window.location.search).get('next') === 'gateway') {
  sessionStorage.setItem('login-return', '/gateway');
}

const login_listener = async () => {
    const response = await fetch('/login', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            username: username.value,
            password: password.value
        }),
    });

    if (response.status === 200) {
        const body = await response.json();
        if (body.requires2FA) {
            window.location.href = '/2fa-challenge';
            return;
        }
        window.Notify('success', body.message);
        passwordForm.innerHTML = `
            <label for="2fa">Code</label>
            <input type="text" id="code" name="code" placeholder="123456" spellcheck="false" autocomplete="off">
        `
        username.disabled = true;
        login.innerHTML = 'Verify';
        login.removeEventListener('click', login_listener);
        login.addEventListener('click', verify_listener);
    } else if (response.status === 301) {
        window.location.href = '/realm-selection';
    } else {
        const body = await response.json();
        window.Notify('error', body.message);
    }
};

const verify_listener = async () => {
    const code = (document.getElementById('code') as HTMLInputElement)?.value?.trim().toUpperCase();
    const params = new URLSearchParams({ username: username.value, code });
    const response = await fetch(`/verify?${params.toString()}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        redirect: 'manual',
    });
    if (response.status === 301 || response.type === 'opaqueredirect') {
        window.location.href = '/realm-selection';
    } else if (response.status === 200) {
        const body = await response.json();
        if (body.requires2FA) {
            window.location.href = '/2fa-challenge';
        } else if (body.emailVerified) {
            window.Notify('success', 'Email verified. Please sign in.');
            passwordForm.innerHTML = `
                <label for="password">Password</label>
                <input type="password" id="password" name="password" placeholder="••••••••" spellcheck="false" autocomplete="off">
            `
            username.disabled = false;
            password.disabled = false;
            login.innerHTML = 'Login';
            login.removeEventListener('click', verify_listener);
            login.addEventListener('click', login_listener);
        } else if (body.verified) {
            window.location.href = '/realm-selection';
        } else {
            window.Notify('error', body.message || 'Verification failed');
        }
    } else {
        const body = await response.json();
        window.Notify('error', body.message);
    }
};

login.addEventListener('click', login_listener);

const guest_listener = async (event?: Event) => {
    event?.preventDefault();
    const response = await fetch('/guest-login', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
    });
    if (response.status === 301) {
        window.location.href = '/realm-selection';
    } else {
        const body = await response.json();
        window.Notify('error', body.message);
    }
};

guestLogin.addEventListener('click', guest_listener);

// A browser that already holds a finished login is offered Play or Logout instead of the form.
const loginForm = document.getElementById('login-form') as HTMLFormElement;
const sessionPanel = document.getElementById('session-panel') as HTMLDivElement;
const sessionUsername = document.getElementById('session-username') as HTMLElement;
const sessionPlay = document.getElementById('session-play-button') as HTMLButtonElement;
const sessionLogout = document.getElementById('session-logout-button') as HTMLButtonElement;

const showLoginForm = () => {
    sessionPanel.classList.add('hidden');
    sessionUsername.textContent = '';
    loginForm.classList.remove('hidden');
};

const showSession = (name: string) => {
    sessionUsername.textContent = name.charAt(0).toUpperCase() + name.slice(1);
    loginForm.classList.add('hidden');
    sessionPanel.classList.remove('hidden');
    sessionPlay.focus();
};

const checkSession = async () => {
    // No token cookie, no session: the page stays as it always was.
    if (!document.cookie.split(';').some((cookie) => cookie.trim().startsWith('token='))) return;
    loginForm.classList.add('hidden');
    try {
        // The server decides: it answers 200 only for a login that finished every step, 2FA included.
        const response = await fetch('/login', { method: 'GET', cache: 'no-store' });
        if (response.status === 200) {
            const body = await response.json();
            if (typeof body?.username === 'string' && body.username) {
                showSession(body.username);
                return;
            }
        }
    } catch {
        // Unknown: fall back to the form.
    }
    showLoginForm();
};

sessionPlay.addEventListener('click', () => {
    window.location.href = '/realm-selection';
});

sessionLogout.addEventListener('click', async () => {
    sessionLogout.disabled = true;
    try {
        const response = await fetch('/login', { method: 'DELETE' });
        if (!response.ok) {
            window.Notify('error', 'Logout failed');
            return;
        }
        showLoginForm();
        window.Notify('success', 'Logged out');
        if (!('ontouchstart' in window) && navigator.maxTouchPoints <= 0) {
            username.focus();
        }
    } catch {
        window.Notify('error', 'Logout failed');
    } finally {
        sessionLogout.disabled = false;
    }
});

const pageParams = new URLSearchParams(window.location.search);
if (pageParams.get('guest') === '1') {
    pageParams.delete('guest');
    const query = pageParams.toString();
    history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : '') + window.location.hash);
    guest_listener();
} else {
    void checkSession();
}

document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        // The session panel's buttons take Enter themselves; the hidden form must not submit.
        if (loginForm.classList.contains('hidden')) return;
        login.click();
    }
});

document.addEventListener('focusout', () => {
    window.setTimeout(() => {
        if (document.activeElement === document.body) {
            window.scrollTo(0, 0);
        }
    }, 100);
});
