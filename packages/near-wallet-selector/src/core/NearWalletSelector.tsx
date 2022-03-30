import React from "react";
import ReactDOM from "react-dom";

import WalletController, {
  SignInParams,
} from "../controllers/WalletController";
import Modal from "../modal/Modal";
import EventHandler, { Emitter, EventList } from "../utils/EventsHandler";
import { updateState } from "../state/State";
import { MODAL_ELEMENT_ID } from "../constants";
import { Options } from "../interfaces/Options";
import { Action } from "../wallets/actions";
import { NetworkConfiguration, resolveNetwork } from "../network";

interface SignAndSendTransactionParams {
  signerId?: string;
  actions: Array<Action>;
}

export default class NearWalletSelector {
  private options: Options;
  private emitter: Emitter;
  private controller: WalletController;

  network: NetworkConfiguration;

  static async init(options: Options) {
    const selector = new NearWalletSelector(options);

    await selector.controller.init();
    selector.renderModal();

    return selector;
  }

  private constructor(options: Options) {
    const network = resolveNetwork(options.network);
    const emitter = new EventHandler();
    const controller = new WalletController(options, network, emitter);

    this.options = options;
    this.network = network;
    this.emitter = emitter;
    this.controller = controller;
  }

  private renderModal() {
    const el = document.createElement("div");
    el.id = MODAL_ELEMENT_ID;
    document.body.appendChild(el);

    ReactDOM.render(
      <Modal
        options={this.options}
        network={this.network}
        wallets={this.controller.getWallets()}
      />,
      document.getElementById(MODAL_ELEMENT_ID)
    );
  }

  show() {
    updateState((prevState) => ({
      ...prevState,
      showModal: true,
      showWalletOptions: true,
      showLedgerDerivationPath: false,
      showWalletNotInstalled: null,
      showSwitchNetwork: false,
    }));
  }

  hide() {
    updateState((prevState) => ({
      ...prevState,
      showModal: false,
    }));
  }

  signIn(params: SignInParams) {
    return this.controller.signIn(params);
  }

  signOut() {
    return this.controller.signOut();
  }

  isSignedIn() {
    return this.controller.isSignedIn();
  }

  getAccounts() {
    return this.controller.getAccounts();
  }

  on(event: EventList, callback: (...args: Array<any>) => void) {
    return this.emitter.on(event, callback);
  }

  off(event: EventList, callback: () => void) {
    this.emitter.off(event, callback);
  }

  getContractId() {
    return this.options.contractId;
  }

  async signAndSendTransaction({
    signerId,
    actions,
  }: SignAndSendTransactionParams) {
    const wallet = this.controller.getSelectedWallet();
    const accounts = this.getAccounts();

    if (!wallet) {
      throw new Error("Wallet not selected");
    }

    if (!accounts.length) {
      throw new Error("No accounts available for signing");
    }

    if (signerId && !accounts.some((x) => x.accountId === signerId)) {
      throw new Error("Invalid signerId");
    }

    return wallet.signAndSendTransaction({
      signerId: signerId || accounts[0].accountId,
      receiverId: this.getContractId(),
      actions,
    });
  }
}
