// Service names the payload registers in the FS's space (space 1).
//
// Every name here is in the FS's own NPDM service list, so SM's RegisterService
// treats it as a known name (an invented name such as `ns2:ro` or `ro:2` wedges
// SM's registration lock). The five previously tried names were all already
// owned by system modules, so SM's GetService returned the system module's
// (dead) session instead of the payload's port.
//
// This list is the remaining FS-listed names most likely to be unregistered on
// a normal boot, plus `fgm:test` as a known-taken control. The payload registers
// ALL of them (best effort), so a free one is live even when earlier ones are
// duplicates. Keep in sync with fresh_names[] in payload/main.c.
module.exports = ['ins:r', 'pm:bm', 'psc:m', 'bpmpmr:m', 'fgm:test'];
