const form = document.getElementById("auth-form");
const message = document.getElementById("auth-message");
const loginTab = document.getElementById("login-tab");
const signupTab = document.getElementById("signup-tab");
const nameField = document.getElementById("name-field");
const confirmField = document.getElementById("confirm-field");
const termsRow = document.getElementById("terms-row");
const rememberRow = document.getElementById("remember-row");
const passwordHint = document.getElementById("password-hint");
let mode = "login";

function setMode(nextMode) {
  mode = nextMode;
  const signingUp = mode === "signup";
  loginTab.classList.toggle("active", !signingUp);
  signupTab.classList.toggle("active", signingUp);
  loginTab.setAttribute("aria-selected", String(!signingUp));
  signupTab.setAttribute("aria-selected", String(signingUp));
  nameField.hidden = !signingUp;
  confirmField.hidden = !signingUp;
  termsRow.hidden = !signingUp;
  rememberRow.hidden = signingUp;
  passwordHint.hidden = !signingUp;
  document.getElementById("form-title").textContent = signingUp ? "Create your account" : "Welcome back";
  document.getElementById("form-subtitle").textContent = signingUp
    ? "Get started with a clearer view of your energy."
    : "Sign in to continue to your dashboard.";
  document.getElementById("password").autocomplete = signingUp ? "new-password" : "current-password";
  document.getElementById("forgot-link").hidden = signingUp;
  document.getElementById("submit-button").innerHTML = signingUp ? "Create account <span>→</span>" : "Sign in <span>→</span>";
  document.getElementById("auth-switch").innerHTML = signingUp
    ? 'Already have an account? <button type="button" class="inline-link" data-switch="login">Sign in</button>'
    : 'New to Wattwise? <button type="button" class="inline-link" data-switch="signup">Create an account</button>';
  message.textContent = "";
  clearErrors();
}

function clearErrors() {
  document.querySelectorAll(".field-error").forEach((node) => { node.textContent = ""; });
  ["full-name", "email", "password", "confirm-password"].forEach((id) => {
    const input = document.getElementById(id);
    input.removeAttribute("aria-invalid");
    input.classList.remove("invalid");
  });
}

function showError(inputId, errorId, text) {
  const input = document.getElementById(inputId);
  input.classList.add("invalid");
  input.setAttribute("aria-invalid", "true");
  document.getElementById(errorId).textContent = text;
}

loginTab.addEventListener("click", () => setMode("login"));
signupTab.addEventListener("click", () => setMode("signup"));
document.getElementById("auth-switch").addEventListener("click", (event) => {
  const switchButton = event.target.closest("[data-switch]");
  if (switchButton) setMode(switchButton.dataset.switch);
});

document.querySelectorAll(".show-password").forEach((button) => {
  button.addEventListener("click", () => {
    const input = button.parentElement.querySelector("input");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    button.textContent = show ? "Hide" : "Show";
    button.setAttribute("aria-label", show ? "Hide password" : "Show password");
    button.setAttribute("aria-pressed", String(show));
  });
});

document.getElementById("forgot-link").addEventListener("click", () => {
  message.className = "auth-message info";
  message.textContent = "Password reset is not set up yet. Contact your Wattwise administrator for help.";
});

form.addEventListener("input", (event) => {
  if (event.target.matches("input")) {
    event.target.classList.remove("invalid");
    event.target.removeAttribute("aria-invalid");
    const errorIds = { "full-name": "name-error", email: "email-error", password: "password-error", "confirm-password": "confirm-error" };
    const err = document.getElementById(errorIds[event.target.id]);
    if (err) err.textContent = "";
    message.textContent = "";
    message.className = "auth-message";
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearErrors();
  message.textContent = "";
  let valid = true;
  const email = document.getElementById("email");
  const password = document.getElementById("password");

  if (!email.value.trim() || !email.validity.valid) {
    showError("email", "email-error", "Enter a valid email address.");
    valid = false;
  }
  if (password.value.length < 8) {
    showError("password", "password-error", "Password must be at least 8 characters.");
    valid = false;
  }
  if (mode === "signup") {
    const name = document.getElementById("full-name");
    const confirm = document.getElementById("confirm-password");
    if (name.value.trim().length < 2) {
      showError("full-name", "name-error", "Enter your name (at least 2 characters).");
      valid = false;
    }
    if (confirm.value !== password.value) {
      showError("confirm-password", "confirm-error", "Passwords do not match.");
      valid = false;
    }
    if (!document.getElementById("terms").checked) {
      message.className = "auth-message error";
      message.textContent = "Please agree to the Terms and Privacy Policy to continue.";
      valid = false;
    }
  }
  if (!valid) return;

  const submit = document.getElementById("submit-button");
  submit.disabled = true;
  submit.textContent = mode === "signup" ? "Creating account…" : "Signing in…";
  try {
    const response = await fetch(mode === "signup" ? "/api/signup" : "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        name: document.getElementById("full-name").value.trim(),
        email: email.value.trim(),
        password: password.value,
        terms: document.getElementById("terms").checked,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to continue. Please try again.");
    message.className = "auth-message info";
    message.textContent = mode === "signup" ? "Account created. Opening your dashboard…" : "Signed in. Opening your dashboard…";
    window.location.assign("index.html");
  } catch (error) {
    message.className = "auth-message error";
    message.textContent = error instanceof TypeError
      ? "Could not reach Wattwise. Start the local server and try again."
      : error.message;
  } finally {
    submit.disabled = false;
    submit.innerHTML = mode === "signup" ? "Create account <span>→</span>" : "Sign in <span>→</span>";
  }
});

fetch("/api/me", { credentials: "same-origin" }).then((response) => {
  if (response.ok) window.location.replace("index.html");
}).catch(() => {});
