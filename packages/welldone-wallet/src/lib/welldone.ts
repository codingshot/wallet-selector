import { Signer, transactions as Transactions, utils } from "near-api-js";
import {
  WalletModuleFactory,
  InjectedWallet,
  WalletBehaviourFactory,
  Action,
  FinalExecutionOutcome,
  waitFor,
  JsonStorageService,
  Optional,
  Transaction,
} from "@near-wallet-selector/core";
import {
  SignAndSendTransactionParams,
  ViewAccessKeyParams,
  WalletProvider,
  WelldoneWalletParams,
  WelldoneWalletState,
} from "./injected-welldone";
import icon from "./icon";
import {
  createAction,
  signTransactions,
} from "@near-wallet-selector/wallet-utils";

export const STORAGE_ACCOUNT = "account";

declare global {
  interface Window {
    dapp: WalletProvider | undefined;
  }
}

const isInstalled = () => {
  return waitFor(() => !!window.dapp).catch(() => false);
};

async function setupWalletState(
  storage: JsonStorageService
): Promise<WelldoneWalletState> {
  const account = await storage.getItem<ViewAccessKeyParams>(STORAGE_ACCOUNT);
  if (window.dapp) {
    const wallet = window.dapp;
    return {
      wallet,
      account: account ? account : undefined,
    };
  }
  return {};
}

const WelldoneWallet: WalletBehaviourFactory<InjectedWallet> = async ({
  options,
  store,
  emitter,
  logger,
  storage,
  provider,
}) => {
  const _state = await setupWalletState(storage);

  const _getAccounts = async () => {
    if (_state.wallet) {
      const res = await _state.wallet.request("near", {
        method: "dapp:accounts",
      });
      return res["near"] ? [res["near"].address, res["near"].pubKey] : [];
    }
    return [];
  };

  const _validateAccessKey = async ({
    accountId,
    publicKey,
  }: ViewAccessKeyParams) => {
    logger.log("validateAccessKey", { accountId, publicKey });
    if (!_state.wallet) {
      throw new Error("Wallet is not installed");
    }
    const accessKey = await _state.wallet.request("near", {
      method: "query",
      params: {
        request_type: "view_access_key",
        finality: "final",
        account_id: accountId,
        public_key: publicKey,
      },
    });

    logger.log("validateAccessKey:accessKey", { accessKey });

    if (accessKey.permission !== "FullAccess") {
      throw new Error("Public key requires 'FullAccess' permission");
    }

    return accessKey;
  };

  const convertActions = (actions: Array<Action>) => {
    const tempActions: Array<Transactions.Action> = [];
    actions.forEach((action) => {
      tempActions.push(createAction(action));
    });
    return tempActions;
  };

  const convertTransaction = (
    publicKey: string,
    nonce: number,
    hash: string,
    { signerId, receiverId, actions }: SignAndSendTransactionParams
  ) => {
    if (!signerId) {
      throw new Error("SignerId error");
    }

    if (!receiverId) {
      throw new Error("ReceiverId error");
    }

    const recentBlockHash = utils.serialize.base_decode(hash);
    const transaction = Transactions.createTransaction(
      signerId,
      utils.PublicKey.fromString(publicKey),
      receiverId,
      nonce,
      convertActions(actions),
      recentBlockHash
    );
    const bytes = transaction.encode();
    return Buffer.from(bytes).toString("base64");
  };

  const cleanup = () => {
    if (_state.account) {
      storage.removeItem(STORAGE_ACCOUNT);
      delete _state.account;
    }
  };

  const getAccounts = () => {
    return _state.account
      ? [
          {
            accountId: _state.account.accountId,
            publicKey: _state.account.publicKey,
          },
        ]
      : [];
  };

  const signOut = async () => {
    cleanup();
    emitter.emit("signedOut", null);
  };

  const setupEvents = () => {
    if (_state.wallet) {
      _state.wallet.on("dapp:accountsChanged", async (newAccountId) => {
        logger.log("onAccountChange", newAccountId);
        await signOut();
      });

      _state.wallet.on("dapp:chainChanged", async (rpc) => {
        logger.log("onNetworkChange", rpc);

        const networkId = rpc.split(":")[1] === "near" ? "mainnet" : "testnet";

        if (options.network.networkId !== networkId) {
          await signOut();

          emitter.emit("networkChanged", { networkId: networkId });
        }
      });
    }
  };

  const signer: Signer = {
    createKey: () => {
      throw new Error("Not implemented");
    },
    getPublicKey: async (accountId) => {
      const accounts = getAccounts();
      const account = accounts.find((a) => a.accountId === accountId);

      if (!account) {
        throw new Error("Failed to find public key for account");
      }

      return utils.PublicKey.from(account.publicKey);
    },
    signMessage: async (message, accountId) => {
      if (!_state.wallet) {
        throw new Error("Wallet is not installed");
      }

      const accounts = getAccounts();
      const account = accounts.find((a) => a.accountId === accountId);

      if (!account) {
        throw new Error("Failed to find account for signing");
      }
      try {
        const tx = Transactions.Transaction.decode(Buffer.from(message));
        const serializedTx = Buffer.from(tx.encode()).toString("hex");
        const signed = await _state.wallet.request("near", {
          method: "dapp:sign",
          params: ["0x" + serializedTx],
        });

        return {
          signature: Buffer.from(signed.signature.substr(2), "hex"),
          publicKey: utils.PublicKey.from(signed.publicKey),
        };
      } catch (err) {
        const decoded = new TextDecoder("utf-8").decode(message);

        const signed = await _state.wallet.request("near", {
          method: "dapp:sign",
          params: [decoded],
        });

        return {
          signature: Buffer.from(signed.signature.substr(2), "hex"),
          publicKey: utils.PublicKey.from(signed.publicKey),
        };
      }
    },
  };

  const transformTransactions = (
    transactions: Array<Optional<Transaction, "signerId" | "receiverId">>
  ): Array<Transaction> => {
    const accounts = getAccounts();
    const { contract } = store.getState();

    if (!accounts.length || !contract) {
      throw new Error("Wallet not signed in");
    }

    return transactions.map((transaction) => {
      return {
        signerId: transaction.signerId || accounts[0].accountId,
        receiverId: transaction.receiverId || contract.contractId,
        actions: transaction.actions,
      };
    });
  };

  return {
    async signIn() {
      const existingAccounts = getAccounts();

      if (existingAccounts.length) {
        return existingAccounts;
      }

      if (_state.account) {
        await signOut();
      }

      const account = await _getAccounts();

      const accessKey = await _validateAccessKey({
        accountId: account[0],
        publicKey: account[1],
      });

      if (!accessKey) {
        signOut();
        throw new Error(
          `Public key (${account[1]}) is not registered with the account '${account[0]}'.`
        );
      }

      await storage.setItem(STORAGE_ACCOUNT, {
        accountId: account[0],
        publicKey: account[1],
      });

      _state.account = {
        accountId: account[0],
        publicKey: account[1],
      };

      setupEvents();

      return getAccounts();
    },

    async getAccounts() {
      return getAccounts();
    },

    signOut,

    async verifyOwner({ message }) {
      logger.log("Welldone:verifyOwner", { message });

      if (!_state.wallet) {
        throw new Error("Wallet is not installed");
      }

      const account = _state.account;

      if (!account) {
        throw new Error("Wallet not signed in");
      }

      const accountId = account.accountId;
      const pubKey = utils.PublicKey.fromString(account.publicKey);
      const block = await _state.wallet.request("near", {
        method: "block",
        params: {
          finality: "final",
        },
      });

      const data = {
        accountId,
        message,
        blockId: block.header.hash,
        publicKey: Buffer.from(pubKey.data).toString("base64"),
        keyType: pubKey.keyType,
      };
      const encoded = JSON.stringify(data);

      const signed = await signer.signMessage(
        new Uint8Array(Buffer.from(encoded)),
        accountId
      );

      return {
        ...data,
        signature: Buffer.from(signed.signature).toString("base64"),
      };
    },

    async signAndSendTransaction({ signerId, receiverId, actions }) {
      logger.log("signAndSendTransaction", { signerId, receiverId, actions });

      const { contract } = store.getState();
      const accounts = getAccounts();

      if (!accounts.length || !contract) {
        throw new Error("Wallet not signed in");
      }

      const [signedTx] = await signTransactions(
        transformTransactions([{ signerId, receiverId, actions }]),
        signer,
        options.network
      );

      return provider.sendTransaction(signedTx);
    },

    async signAndSendTransactions({ transactions }) {
      if (!_state.wallet) {
        throw new Error("Wallet is not installed");
      }

      if (!_state.account) {
        throw new Error("Wallet not signed in");
      }

      const accessKey = await _validateAccessKey(_state.account);
      const publicKey = _state.account.publicKey;

      let nonce = accessKey.nonce;

      const convertedTxs = transactions.map((tx) => {
        nonce++;
        return convertTransaction(publicKey, nonce, accessKey.block_hash, tx);
      });

      const txHashes = await _state.wallet.request("near", {
        method: "dapp:sendTransaction",
        params: [...convertedTxs],
      });

      const results: Array<FinalExecutionOutcome> = [];

      for (let i = 0; i < txHashes.length; i++) {
        results.push(
          await _state.wallet.request("near", {
            method: "tx",
            params: [txHashes[i], transactions[i].signerId],
          })
        );
      }

      return results;
    },
  };
};

export function setupWelldoneWallet({
  iconUrl = icon,
  deprecated = false,
}: WelldoneWalletParams = {}): WalletModuleFactory<InjectedWallet> {
  return async () => {
    const installed = await isInstalled();

    return {
      id: "welldone-wallet",
      type: "injected",
      metadata: {
        name: "WELLDONE Wallet",
        description: "WELLDONE Wallet for Multichains",
        iconUrl,
        downloadUrl:
          "https://chrome.google.com/webstore/detail/welldone-wallet/bmkakpenjmcpfhhjadflneinmhboecjf",
        deprecated,
        available: installed,
      },
      init: WelldoneWallet,
    };
  };
}
