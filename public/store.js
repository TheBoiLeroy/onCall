// Caregiver keys are kept on the caregiver's device only (localStorage).
window.CareStore = {
  all() {
    try { return JSON.parse(localStorage.getItem('carecall.rooms') || '[]'); } catch { return []; }
  },
  get(id) { return this.all().find((r) => r.id === id); },
  add(room) {
    const rooms = this.all().filter((r) => r.id !== room.id);
    rooms.unshift({ id: room.id, caregiverKey: room.caregiverKey, patientName: room.patientName, createdAt: room.createdAt });
    localStorage.setItem('carecall.rooms', JSON.stringify(rooms));
  },
  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
