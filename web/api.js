const TOKEN = document.querySelector('meta[name="ezlearn-token"]')?.content || '';

async function req(method, url, body, isForm = false) {
  const opt = { method, headers: { 'X-Ezlearn-Token': TOKEN }, credentials: 'same-origin', cache: 'no-store' };
  if (body !== undefined) {
    if (isForm) opt.body = body;
    else { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  }
  const r = await fetch(`/api${url}`, opt);
  if (r.status === 204) return null;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status, data });
  return data;
}

export const api = {
  get: (u) => req('GET', u),
  post: (u, b) => req('POST', u, b ?? {}),
  put: (u, b) => req('PUT', u, b),
  patch: (u, b) => req('PATCH', u, b),
  del: (u) => req('DELETE', u),
  upload: (u, form) => req('POST', u, form, true),
};

const enc = encodeURIComponent;
export const paths = {
  course: (c) => `/courses/${enc(c)}`,
  chapter: (c, ch) => `/courses/${enc(c)}/chapters/${enc(ch)}`,
  material: (c, m) => `/courses/${enc(c)}/materials/${enc(m)}`,
};
