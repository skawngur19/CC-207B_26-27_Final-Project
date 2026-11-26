(() => {
'use strict';
const money = (value) => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', maximumFractionDigits: value % 100 ? 2 : 0 }).format(value / 100);
const escapeHTML = (value = '') => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function phtDate(date = new Date()) { return new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(date); }
function formatDate(date, options = {}) { return new Intl.DateTimeFormat('en-PH', {month:'long',day:'numeric',year:'numeric',...options,timeZone:'UTC'}).format(new Date(`${date}T00:00:00Z`)); }
function hour(h) { return `${h % 12 || 12}:00 ${h < 12 ? 'AM' : 'PM'}`; }
function calendarCells(year, month) { return [...Array(new Date(Date.UTC(year, month, 1)).getUTCDay()).fill(null), ...Array.from({length:new Date(Date.UTC(year,month+1,0)).getUTCDate()},(_,i)=>i+1)]; }
function availability(bookings, resourceId, date, start, end) { return bookings.find(b => b.resourceId === resourceId && b.date === date && !['cancelled','completed'].includes(b.status) && b.startHour < end && b.endHour > start); }
function reservationTotal(resource, start, end) { return resource ? resource.rate * Math.max(0,end-start) : 0; }
function cartTotal(products, cart, booking) { return products.reduce((sum,p)=>sum + p.price * (cart[p.id] || 0),0) + (booking && !booking.paid ? booking.total : 0); }
function newOperationId() { return crypto.randomUUID(); }

globalThis.ClinchDomain = Object.freeze({money,escapeHTML,phtDate,formatDate,hour,calendarCells,availability,reservationTotal,cartTotal,newOperationId});
})();
