// FA-15127: every contract this app asks a wallet to call or to approve, keyed by chain id. Lowercase.
// A target missing here is refused before the wallet prompt (tx/guard.js); adding one is a reviewed change.
const FEE_DISTRIBUTORS = ['0xd16d5ec345dd86fb63c6a9c43c517210f1027914', '0xa5d9358c60fc9bd2b508eda17c78c67a43a4458c', '0xd11b416573ebc59b6b2387da0d2c0d1b3b1f7a90'];
const CLEVER_DISTRIBUTORS = ['0x261e3aeb4cd1ebfd0fa532d6acdd4b21ebdcd2de', '0xb5e7f9cb9d3897808658f1991ad32912959b42e2'];
const AERODROME = ['0x16613524e02ad97edfef371bc883f2f5d6c480a5', '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43', '0x6c99671b249af73b2847d92123d823cb3875e399'];
const SLIPSTREAM = ['0xbe6d8f0d05cc4be24d5167a3ef062215be6d18a5', '0xcbbb8035cac7d4b3ca7abb74cf7bdf900215ce0d', '0x698cb2b6dd822994581fea6ea4fc755d1363a92f'];
const VELODROME_ROOT = ['0xa062ae8a9c5e11aaa026fc2670b0d65ccc8b2858', '0x41c914ee0c7e1a5edcd0295623e6dc557b5abf3c', '0x6f26bf09b1c792e3228e5467807a900a503c0281'];
const LEAF = ['0x3a63171dd9bebf4d07bc782fecc7eb0b890c2a45', '0x1a9d17828897d6289c6dff9dc9f5cc3baea17814'];
const LIFI = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae';
const LIFI_NEW = '0x864b314d4c5a0399368609581d3e8933a63b9232';
export const KNOWN_TARGETS = { 1: [...FEE_DISTRIBUTORS, ...CLEVER_DISTRIBUTORS], 8453: [...AERODROME, ...SLIPSTREAM], 10: VELODROME_ROOT };
KNOWN_TARGETS[42220] = [...LEAF, LIFI]; // Celo
KNOWN_TARGETS[252] = [...LEAF, LIFI]; // Fraxtal
KNOWN_TARGETS[57073] = [...LEAF, LIFI_NEW, '0xef684c38f94f48775959ecf2012d7e864ffb9dd4']; // Ink, with its Across SpokePool
KNOWN_TARGETS[1135] = [...LEAF, LIFI]; // Lisk
KNOWN_TARGETS[1750] = LEAF; // Metal L2
KNOWN_TARGETS[34443] = [...LEAF, LIFI]; // Mode
KNOWN_TARGETS[1868] = [...LEAF, LIFI_NEW, '0x3bad7ad0728f9917d1bf08af5782dcbd516cdd96']; // Soneium, with its Across SpokePool
KNOWN_TARGETS[5330] = LEAF; // Superseed
KNOWN_TARGETS[1923] = LEAF; // Swellchain
KNOWN_TARGETS[130] = [...LEAF, LIFI_NEW, '0x09aea4b2242abc8bb4bb78d537a67a245a7bec64']; // Unichain, with its Across SpokePool
Object.values(KNOWN_TARGETS).forEach((list) => Object.freeze(list));
Object.freeze(KNOWN_TARGETS);