(() => {
'use strict';
const paths = {
book:'<path d="M12 20c-2-3-5-3-9-3V4c4 0 7 0 9 3 2-3 5-3 9-3v13c-4 0-7 0-9 3Zm0-13v13"/>',
home:'<path d="m3 10 9-7 9 7v10H3Zm6 10v-8h6v8"/>',
calendar:'<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v5m10-5v5M3 11h18m-14 4h2m3 0h2m3 0h1m-11 3h2m3 0h2"/>',
ticket:'<path d="M3 5h18v5a2 2 0 0 0 0 4v5H3v-5a2 2 0 0 0 0-4Zm12 1v3m0 3v3m0 2v2"/>',
user:'<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
users:'<circle cx="9" cy="7" r="4"/><path d="M1 21v-2a8 8 0 0 1 16 0v2m1-18a4 4 0 0 1 0 8m2 3a7 7 0 0 1 3 6"/>',
seat:'<path d="M6 11V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v6M4 10a2 2 0 0 1 2 2v2h12v-2a2 2 0 0 1 4 0v7H2v-7a2 2 0 0 1 2-2Zm0 9v3m16-3v3"/>',
arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',
arrowUp:'<path d="M5 19 19 5M5 5h14v14"/>',
check:'<path d="m5 12 5 5L20 7"/>',
location:'<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
clock:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6h5"/>',
briefcase:'<rect x="3" y="7" width="18" height="14" rx="3"/><path d="M8 7V3h8v4M3 12c6 4 12 4 18 0m-10 2h2"/>',
bell:'<path d="M4 17h16l-2-4V8a6 6 0 0 0-12 0v5Zm5 3a3 3 0 0 0 6 0"/>',
shield:'<path d="m12 2 9 4v6c0 5-9 10-9 10s-9-5-9-10V6Zm-5 9 4 4 6-7"/>',
wifi:'<path d="M2 8a17 17 0 0 1 20 0M5 12a12 12 0 0 1 14 0m-11 4a6 6 0 0 1 8 0m-4 4h.01"/>',
logout:'<path d="M9 3H3v18h6m5-14 5 5-5 5m-5-5h13"/>',
plus:'<path d="M12 5v14M5 12h14"/>',
minus:'<path d="M5 12h14"/>',
close:'<path d="m5 5 14 14M5 19 19 5"/>',
chevron:'<path d="m9 5 7 7-7 7"/>',
coffee:'<path d="M4 9h13v8a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4Zm13 1h2a3 3 0 0 1 0 6h-2M7 2v4m4-4v4m4-4v4"/>',
receipt:'<path d="m5 2 3 2 4-2 4 2 3-2v20l-3-2-4 2-4-2-3 2Zm3 6h8m-8 4h8m-8 4h4"/>',
chart:'<path d="M3 3v18h19M7 16V9m5 7V5m5 11v-4"/>',
sync:'<path d="M20 8a9 9 0 0 0-15-3L2 8m0-6v6h6m-4 8a9 9 0 0 0 15 3l3-3m0 6v-6h-6"/>',
mail:'<rect x="2" y="4" width="20" height="16" rx="3"/><path d="m3 6 9 7 9-7"/>',
lock:'<rect x="4" y="10" width="16" height="12" rx="3"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v3"/>',
eye:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
sun:'<circle cx="12" cy="12" r="4"/><path d="M12 1v2m0 18v2M1 12h2m18 0h2M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2"/>'
};
function icon(name, cls='') { return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.book}</svg>`; }
const logo = `<span class="brand-mark">${icon('book')}</span><span class="brand-word">clinch<span>STUDY HUB</span></span>`;

globalThis.ClinchIcons = Object.freeze({icon,logo});
})();
