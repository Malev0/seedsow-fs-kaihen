// The parent runner owns the lifetime of an opt-in held FS endpoint. The
// release message carries the caller's outcome (`ok`) so the pipeline can tell
// a completed HEN start from a failed one before publishing the 4/4 stage.
function waitForRelease(channel = process) {
  if (typeof channel.send !== 'function')
    throw Error('Held FS mode requires the runner IPC channel');
  return new Promise(resolve => {
    let settled = false;
    const finish = (reason, ok) => {
      if (settled) return;
      settled = true;
      channel.removeListener('message', message);
      channel.removeListener('disconnect', disconnect);
      resolve({reason, ok});
    };
    const message = value => {
      if (value?.type === 'release') finish('release', value.ok !== false);
    };
    const disconnect = () => finish('parent-disconnected', false);
    channel.on('message', message);
    channel.once('disconnect', disconnect);
    if (channel.connected === false) finish('parent-disconnected', false);
  });
}

module.exports = {waitForRelease};
