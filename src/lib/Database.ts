import { Memento } from "vscode";
import FDBDatabase from "../FDBDatabase.js";
import FDBTransaction from "../FDBTransaction.js";
import ObjectStore from "./ObjectStore.js";
import { queueTask } from "./scheduling.js";
import { KeyPath } from "./types.js";

interface ObjectStoreInfo {
    name: string,
    keyPath: KeyPath | null,
    autoIncrement: boolean,
}

// http://www.w3.org/TR/2015/REC-IndexedDB-20150108/#dfn-database
class Database {
    public deletePending = false;
    public readonly transactions: FDBTransaction[] = [];
    private _rawObjectStores: ReadonlyMap<string, ObjectStore>| undefined;
    public connections: FDBDatabase[] = [];

    public readonly name: string;
    public version: number;

    constructor(name: string, version: number, public memento: Memento) {
        this.name = name;
        this.version = version;

        this.processTransactions = this.processTransactions.bind(this);
    }


    public get rawObjectStores() : ReadonlyMap<string, ObjectStore> {
        if(!this._rawObjectStores) {
            const entries = this.memento
                .get<ObjectStoreInfo[]>(`IDBFactory.databases['${this.name}'].objectStores`)
                ?.map<[string, ObjectStore]>(it => [it.name, new ObjectStore(this, it.name, it.keyPath, it.autoIncrement)])
                || [];
            this._rawObjectStores = new Map(entries);
        }
        return this._rawObjectStores!
    }

    public set rawObjectStores(value: ReadonlyMap<string, ObjectStore>) {
        this._rawObjectStores = value;
        this.memento.update(
            `IDBFactory.databases['${this.name}'].objectStores`, 
            Array.from(value.values()).map<ObjectStoreInfo>(it => ({ name: it.name, keyPath: it.keyPath, autoIncrement: it.autoIncrement }))
        ).then(() => , it => console.error(it));   
    }

    public processTransactions() {
        queueTask(() => {
            const anyRunning = this.transactions.some((transaction) => {
                return (
                    transaction._started && transaction._state !== "finished"
                );
            });

            if (!anyRunning) {
                const next = this.transactions.find((transaction) => {
                    return (
                        !transaction._started &&
                        transaction._state !== "finished"
                    );
                });

                if (next) {
                    next.addEventListener("complete", this.processTransactions);
                    next.addEventListener("abort", this.processTransactions);
                    next._start();
                }
            }
        });
    }
}

export default Database;
