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

// The gateway dashboard sends admins here to sign in (/?next=gateway). The
// realm selection page sends them back to it once they have.
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

// Demo links open straight into guest play (/?guest=1). The parameter is
// dropped from the address first so Back to this page does not make
// another guest account.
const pageParams = new URLSearchParams(window.location.search);
if (pageParams.get('guest') === '1') {
    pageParams.delete('guest');
    const query = pageParams.toString();
    history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : '') + window.location.hash);
    guest_listener();
}

document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        login.click();
    }
});

// If Safari panned the page for the keyboard, settle back to the top
// once editing ends so the card is never left pushed up.
document.addEventListener('focusout', () => {
    window.setTimeout(() => {
        if (document.activeElement === document.body) {
            window.scrollTo(0, 0);
        }
    }, 100);
});
