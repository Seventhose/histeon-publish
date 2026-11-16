/** Modules the browser bundle never needs (node:sqlite, yazl, yauzl): any use is refused with a clear message. */
const refuse = (): never => {
  throw new Error("Funzione non disponibile nel browser.");
};
export class DatabaseSync {
  constructor() {
    refuse();
  }
}
export const ZipFile = DatabaseSync;
export const open = refuse;
export const fromBuffer = refuse;
export default { ZipFile, open, fromBuffer };
