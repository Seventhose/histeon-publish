/**
 * `node:fs` and `node:fs/promises` in the browser bundle of the importer (doc 18 F6): a project there lives in memory
 * (memory-catalog.ts), so reaching the disk is a mistake, refused with a clear message.
 */
const refuse = (name: string) => (): never => {
  throw new Error(`${name} non è disponibile nel browser: il progetto vive in memoria.`);
};
export const constants = { O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_NOFOLLOW: 131072 };
export const chmod = refuse("chmod");
export const copyFile = refuse("copyFile");
export const link = refuse("link");
export const lstat = refuse("lstat");
export const mkdir = refuse("mkdir");
export const open = refuse("open");
export const readFile = refuse("readFile");
export const readdir = refuse("readdir");
export const realpath = refuse("realpath");
export const rename = refuse("rename");
export const rm = refuse("rm");
export const unlink = refuse("unlink");
export const writeFile = refuse("writeFile");
export const stat = refuse("stat");
export const chmodSync = refuse("chmodSync");
export const closeSync = refuse("closeSync");
export const fstatSync = refuse("fstatSync");
export const fsyncSync = refuse("fsyncSync");
export const lstatSync = refuse("lstatSync");
export const mkdirSync = refuse("mkdirSync");
export const openSync = refuse("openSync");
export const readSync = refuse("readSync");
export const realpathSync = refuse("realpathSync");
export const renameSync = refuse("renameSync");
export const rmSync = refuse("rmSync");
export const writeSync = refuse("writeSync");
export const readFileSync = refuse("readFileSync");
export const existsSync = (): boolean => false;
export const promises = { readFile, writeFile, mkdir, rm, stat };
export default { constants, promises, readFileSync, existsSync };
