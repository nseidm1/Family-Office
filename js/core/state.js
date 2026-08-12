export const state = {
  provider: null,      // EIP-1193 provider currently in use
  info: null,          // EIP-6963 provider info ({ name, icon, rdns, uuid })
  account: null,
  chainId: null,
  listeners: null,     // detach handle for provider events
};

