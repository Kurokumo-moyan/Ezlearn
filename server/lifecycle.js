// 进程生命周期：由桌面启动器拉起时，窗口关闭（不再有心跳）且没有任务在跑，服务就自动退出，不留后台进程。
let lastSeen = Date.now();
let shutdownFn = null;

export const touch = () => { lastSeen = Date.now(); };
export const idleMs = () => Date.now() - lastSeen;
export const setShutdown = (fn) => { shutdownFn = fn; };
export const canShutdown = () => Boolean(shutdownFn);
export const requestShutdown = () => { if (shutdownFn) shutdownFn(); };
