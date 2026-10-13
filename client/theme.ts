type Theme = 'light' | 'dark' | 'system';
const media = matchMedia('(prefers-color-scheme: dark)');
let preference: Theme = 'system';
try {
  const saved = localStorage.getItem('bimabat-theme');
  if (saved === 'light' || saved === 'dark') preference = saved;
} catch { /* System preference still works when storage is unavailable. */ }
function applyTheme(): void {
  const dark = preference === 'dark' || (preference === 'system' && media.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const control = document.getElementById('theme') as HTMLSelectElement | null;
  if (control) control.value = preference;
}
applyTheme();
media.addEventListener('change', applyTheme);
document.addEventListener('DOMContentLoaded', () => {
  applyTheme();
  document.getElementById('theme')?.addEventListener('change', (event) => {
    const selected = (event.target as HTMLSelectElement).value;
    preference = selected === 'light' || selected === 'dark' ? selected : 'system';
    try { localStorage.setItem('bimabat-theme', preference); } catch { /* Keep the current session theme. */ }
    applyTheme();
  });
});
