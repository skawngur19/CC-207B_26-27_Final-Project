(() => {
'use strict';
// Ambiguous network failures keep the immutable operation available for retry.
class CheckoutGuard {
  body = null;
  busy = false;
  uncertain = false;
  quotedTotal = 0;
  get locked() { return this.busy || this.uncertain; }
  restore(body, quotedTotal = 0) { this.body=structuredClone(body);this.quotedTotal=quotedTotal;this.busy=false;this.uncertain=true; }
  begin(payload, quotedTotal = 0) {
    if (this.busy) throw new Error('This checkout is already being recorded.');
    if (!this.uncertain) { this.body = structuredClone({...payload, operationId:crypto.randomUUID()});this.quotedTotal=quotedTotal; }
    this.busy = true;
    return structuredClone(this.body);
  }
  accepted() { this.body=null;this.busy=false;this.uncertain=false;this.quotedTotal=0; }
  failed(status, code) {
    this.busy=false;
    // These business errors follow the server's receipt lookup, so no matching
    // committed sale exists. Auth/throttling failures occur before that lookup.
    const definitive=['OUT_OF_STOCK','STALE_VERSION','ALREADY_PAID','INVALID_BOOKING','INSUFFICIENT_CASH','VALIDATION','NOT_FOUND'].includes(code);
    this.uncertain=(this.uncertain&&!definitive)||!status||status>=500;
    if(!this.uncertain){this.body=null;this.quotedTotal=0;}
  }
}

globalThis.ClinchCheckout = Object.freeze({CheckoutGuard});
})();
