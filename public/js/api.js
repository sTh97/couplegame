const TOKEN_KEY = "cg_session";
const DEVICE_KEY = "cg_device";
const NICK_KEY = "cg_nick";

export function deviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export async function api(path, { method = "GET", body } = {}) {
  const token = getToken();
  const res = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = { message: "Unexpected response" };
  }
  if (data.sessionToken) setToken(data.sessionToken);
  if (!res.ok) {
    const err = new Error(data.message || "Something went wrong.");
    err.code = data.code;
    err.status = res.status;
    throw err;
  }
  return data;
}
