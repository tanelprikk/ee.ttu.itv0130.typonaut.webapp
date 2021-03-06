import { inject, bindable } from 'aurelia-framework';
import { EventAggregator } from 'aurelia-event-aggregator';

import 'jquery';
import 'jquery-ui-dist';

import environment from '../../environment';
import { DataAPI } from '../../gateways/data/data-api';
import { ConnectionAPI } from '../../gateways/connection/connection-api';

import { isEmpty } from '../../lib/string-utils';
import * as eventTypes from '../../events/event-types';
import * as MessageTypes from '../../lib/message-types';
import * as envTypes from '../../consts/environment-types';

@inject(Element, EventAggregator, DataAPI, ConnectionAPI)
export class GameContainer {
  @bindable currentNickname = '';
  @bindable word = '';

  constructor(element, eventAggregator, dataAPI, connectionAPI) {
    this.element = element;
    this.eventAggregator = eventAggregator;
    this.dataAPI = dataAPI;
    this.connectionAPI = connectionAPI;

    this.initStateModel();
  }

  attached() {
    this.audioBank = {
      victoryDing: new Audio('media/audio/victory-ding.ogg'),
      lossDing: new Audio('media/audio/loss-ding.ogg'),
      closeItem: new Audio('media/audio/close-item.ogg'),
      loserPointDing: new Audio('media/audio/loser-point-ding.ogg'),
      winnerPointDing: new Audio('media/audio/winner-point-ding.ogg'),
      wordMismatch: new Audio('media/audio/word-mismatch.ogg'),
      joinGame: new Audio('media/audio/join-game.ogg'),
      opponentFound: new Audio('media/audio/opponent-found.ogg'),
      opponentLeft: new Audio('media/audio/opponent-left.ogg'),
      taunt: new Audio('media/audio/nelson-taunt.mp3')
    };

    this.initStateModel();
    this.initDOMHooks();
    this.attachDOMListeners();

    this.connectToServer();
  }

  detached() {
    this.detachDOMListeners();
    this.clearPingInterval();
  }

  /* INITIALIZERS */
  initStateModel() {
    /* set to true right away to avoid displaying nickname form */
    this.isApplicationLocked = false;
    this.isConnectingToServer = true;
    this.isSettingNickname = false;
    this.isWaitingForOpponent = false;
    this.isWaitingForNextRound = false;
    this.isCheckingWord = false;
    this.hasJoinedGameAtLeastOnce = false;

    this.hasJoinedGame = false;
    this.isInRound = true;
    this.showWinStatus = false;
    this.showMessageBanner = false;
    this.canJoinGame = false;
    this.canDisplayTutorial = false;
    this.canTauntOpponent = false;

    this.pingInterval = null;
    this.isInGame = false;
    this.lastScoreIndex = null;
    this.currentOpponent = null;
    this.sessionId = null;
    this.didWin = null;
    this.isNicknameSet = false;
    this.loadingText = null;
    this.currentMessage = null;
    this.challengeWaitText = null;
    this.currentScore = 0;
  }

  initDOMHooks() {
    this.getVictoryBanner = () => (this.element.querySelector('#victory-banner'));
    this.getMessageBanner = () => (this.element.querySelector('#message-banner'));
    this.getScoreWrapper = () => (this.element.querySelector('#score-wrapper'));
    this.getVictoryTextContainer = () => (this.element.querySelector('#victory-text-container'));
    this.getWordInput = () => (this.element.querySelector('.word-input'));
  }

  attachDOMListeners() {}

  detachDOMListeners() {}

  connectToServer() {
    const serverSocket = this.serverSocket = this.connectionAPI.getGameSocketConnection();
    this.hookUpServerSocket(serverSocket);
  }

  hookUpServerSocket(serverSocket) {
    this.isConnectingToServer = true;
    this.loadingText = 'Connecting to server...';
    serverSocket.onopen = (event) => {
      this.isConnectingToServer = false;
    };

    serverSocket.onclose = (event) => {
      console.warn(event);
      // lock page
      this.isApplicationLocked = true;
      this.clearPingInterval();
    };

    serverSocket.onerror = () => {
      console.warn(event);
      // lock page
      this.isApplicationLocked = true;
      this.clearPingInterval();
    };

    serverSocket.onmessage = (event) => {
      const data = JSON.parse(event.data);

      switch (data.type) {
      case MessageTypes.CONNECT_RESPONSE:
        this.handleConnectResponse(data);
        break;
      case MessageTypes.SET_NICKNAME_RESPONSE:
        this.handleSetNicknameResponse(data);
        break;
      case MessageTypes.BROADCAST_WORD:
        this.handleBroadcastWord(data);
        break;
      case MessageTypes.TYPE_WORD_RESPONSE:
        this.handleTypeWordResponse(data);
        break;
      case MessageTypes.TERMINATE_GAME:
        this.handleTerminateGame(data);
        break;
      case MessageTypes.FORWARD_TAUNT:
        this.handleForwardTaunt();
        break;
      default:
        break;
      }
    };

    if (environment.type === envTypes.PROD) {
      // need to ping amazon otherwise the connection dies
      this.pingInterval = setInterval(() => {
        console.info('keep-alive');
        this.sendToServer({ type: 'PING' });
      }, 5000);
    }
  }

  clearPingInterval() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
  /* /INITIALIZERS */

  /* SERVER MESSAGE HANDLERS */
  handleConnectResponse(data) {
    this.sessionId = data.sessionId;
  }

  handleSetNicknameResponse(data) {
    this.isSettingNickname = false;
    this.isNicknameSet = true;

    this.canDisplayTutorial = true;
    this.canJoinGame = true;
    this.isInGame = false;
  }

  handleBroadcastWord(data) {
    if (this.hasJoinedGame) {
      playAudio(this.audioBank.opponentFound);
      this.hasJoinedGameAtLeastOnce = true;
      this.isWaitingForOpponent = false;
      this.isWaitingForNextRound = false;
      this.isInRound = true;
      this.currentWord = data.word;
      this.currentOpponent = data.opponentNickname;
      this.isInGame = true;
      this.hasNotSentWord = true;

      this.dataAPI.getScoreRequest(this.sessionId, this.lastScoreIndex || '0')
      .send()
      .then((response) => {
        const { roundScores } = response.content;

        roundScores.forEach((roundScore) => {
          this.eventAggregator.publish(new eventTypes.NewScore(roundScore));
          this.lastScoreIndex = roundScore.index;
        });
      })
      .catch((err) => {});
    }
  }

  handleTypeWordResponse(data) {
    this.isCheckingWord = false;
    switch (data.gameMessageType) {
    case MessageTypes.WORD_MISMATCH:
      this.handleWordMismatch();
      break;
    case MessageTypes.ROUND_WON:
      this.handleRoundWon(data);
      break;
    case MessageTypes.ROUND_LOST:
      this.handleRoundLost(data);
      break;
    default:
      break;
    }
  }

  handleWordMismatch() {
    if (this.messageBannerHideTimeout) {
      clearTimeout(this.messageBannerHideTimeout);
    }

    playAudio(this.audioBank.wordMismatch);
    this.flashMessage('Try again!', 1000);
    // this.getWordInput().focus();
  }

  handleRoundWon(data) {
    this.handleRoundEnd(data, true);
  }

  handleRoundLost(data) {
    this.handleRoundEnd(data, false);
  }

  handleTerminateGame(data) {
    this.hasJoinedGame = false;
    this.isInGame = false;
    this.isInRound = false;
    this.currentOpponent = null;

    playAudio(this.audioBank.opponentLeft);
    this.flashMessage('Your opponent left!', 2000);
    setTimeout(() => this.canJoinGame = true, 2000);
  }

  handleRoundEnd(data, victory) {
    if (victory) {
      playAudio(this.audioBank.victoryDing);
      this.canTauntOpponent = true;
    } else {
      playAudio(this.audioBank.lossDing);
    }

    this.showMessageBanner = false;
    this.isInRound = false;
    this.showWinStatus = true;
    this.challengeWaitText = victory
     ? 'Waiting for opponent to finish...'
     : 'Waiting for next challenge...';
    this.didWin = victory;
    this.typedWord = '';

    const victoryBanner = this.getVictoryBanner();
    victoryBanner.classList.remove('fadeOut');

    setTimeout(() => this.transferPoints(data.playerScore, victory), 500);

    setTimeout(() => {
      victoryBanner.classList.add('fadeOut');
      setTimeout(() => {
        this.showWinStatus = false;
        this.isWaitingForNextRound = true;
        this.didWin = null;
      }, 500);
    }, 1000);
  }

  transferPoints(points, victory) {
    const scoreWrapper = this.getScoreWrapper();
    const victoryTextContainer = this.getVictoryTextContainer();

    const $scoreWrapper = $(scoreWrapper);
    const $victoryTextContainer = $(victoryTextContainer);

    const startTopOffset = $victoryTextContainer.offset().top + 20;
    const startLeftOffset = $victoryTextContainer.offset().left + 85;
    const endTopOffset = $scoreWrapper.offset().top;
    const endLeftOffset = $scoreWrapper.offset().left;
    const starIcon = document.createElement('i');
    const pointsDiv = document.createElement('div');

    const pointsDivCss = {
      color: 'green',
      'font-weight': 'bold',
      'font-size': '13px'
    };
    pointsDiv.css = pointsDivCss;

    starIcon.classList.add('fa');
    starIcon.classList.add('fa-star');
    const starIconCss =  {
      'font-size': '24px',
      position: 'absolute'
    };
    starIcon.style = starIconCss;

    const moveStar = (color, amount) => {
      const $starIcon = $(starIcon.cloneNode());
      $starIcon
        .offset({
          top: startTopOffset,
          left: startLeftOffset
        })
        .css(Object.assign({
          opacity: '0.5',
          color,
          position: 'absolute',
          'z-index': '100'
        }, starIconCss))
        .appendTo($('body'))
        .animate({
          'top': endTopOffset,
          'left': endLeftOffset
        }, 500, 'easeInOutExpo', () => {
          if (victory) {
            playAudio(this.audioBank.winnerPointDing);
          } else {
            playAudio(this.audioBank.loserPointDing);
          }

          $scoreWrapper.effect('bounce', { times: victory ? 2 : 1 }, 100);
          $starIcon.remove();
          this.currentScore += amount;
          const $pointsDiv = $(pointsDiv.cloneNode());
          $pointsDiv
            .text(`+${amount}`)
            .css(Object.assign({
              opacity: '0.5',
              color,
              position: 'absolute',
              'z-index': '100'
            }, pointsDivCss))
            .offset({
              top: endTopOffset,
              left: endLeftOffset
            })
            .appendTo($('body'))
            .addClass('animated fadeOutUp');
          setTimeout(() => $pointsDiv.remove(), 500);
        });
    };

    let i = 1;
    let color;
    let transfers;
    let amount;
    if (victory) {
      color = 'gold';
      amount = 10;
      transfers = points / 10;
    } else {
      // bronze
      color = '#CD7F32';
      amount = 1;
      transfers = points;
    }

    while (transfers-- > 0) {
      setTimeout(() => moveStar(color, amount), 150 * i++);
    }
  }

  handleForwardTaunt() {
    playAudio(this.audioBank.taunt);
    this.flashMessage(`${this.currentOpponent} taunts you!`, 1000);
  }
  /* /SERVER MESSAGE HANDLERS */

  /* USER INTERACTION HANDLERS */
  handleSetNicknameClick() {
    if (this.currentNickname) {
      playAudio(this.audioBank.closeItem);
      this.setNickname();
    }
  }

  handleJoinGameClick() {
    playAudio(this.audioBank.joinGame);
    this.joinGame();
  }

  handleWordSubmit() {
    if (!this.isWordInputDisabled) {
      if (this.canSubmitWord) {
        this.sendWord();
      } else {
        this.handleWordMismatch();
      }
    }
  }

  handleTauntOpponentClick() {
    if (this.canTauntOpponent) {
      playAudio(this.audioBank.taunt);
      this.sendToServer({ type: MessageTypes.SEND_TAUNT });
      this.canTauntOpponent = false;
    }
  }
  /* /USER INTERACTION HANDLERS */

  /* APP LOGIC */
  setNickname() {
    this.loadingText = 'Setting nickname...';
    this.isSettingNickname = true;
    const nickname = this.currentNickname;
    const message = constructMessage(MessageTypes.SET_NICKNAME, { nickname });
    this.sendToServer(message);
  }

  joinGame() {
    this.loadingText = 'Waiting for an opponent...';
    this.hasJoinedGame = true;
    this.isWaitingForOpponent = true;
    this.canDisplayTutorial = false;
    this.canJoinGame = false;
    const message = constructMessage(MessageTypes.JOIN_GAME);
    this.sendToServer(message);
  }

  sendWord() {
    this.isCheckingWord = true;
    const message = constructMessage(MessageTypes.TYPE_WORD, { word: this.typedWord });
    this.sendToServer(message);
  }
  /* /APP LOGIC */

  /* VISIBLITY LOGIC */
  get showLoadingBanner() {
    return this.isConnectingToServer || !this.sessionId || this.isSettingNickname || this.isWaitingForOpponent;
  }

  get showNicknameForm() {
    return !this.isConnectingToServer && !this.isNicknameSet;
  }

  get canSetNickname() {
    return !isEmpty(this.currentNickname);
  }

  get showTutorial() {
    return this.canDisplayTutorial;
  }

  get showJoinGameForm() {
    return this.canJoinGame;
  }

  get showGameArea() {
    return this.isInGame && !this.isConnectingToServer;
  }

  get showCurrentScore() {
    return this.isInGame || this.hasJoinedGameAtLeastOnce;
  }

  get showChallengeArea() {
    return this.isInRound && !this.isWaitingForNextRound;
  }

  get showChallengeWaitArea() {
    return !this.isInRound && this.isWaitingForNextRound;
  }

  get showHistorySidebar() {
    return this.showCurrentScore;
  }
  /* /VISIBLITY LOGIC */

  /* DISPLAY FORMAT LOGIC */
  get currentScoreString() {
    return ('0000' + this.currentScore).slice(-5);
  }
  /* /DISPLAY FORMAT LOGIC */

  /* GATEWAY LOGIC */
  get canSubmitWord() {
    return !isEmpty(this.typedWord);
  }

  get isWordInputDisabled() {
    return this.isCheckingWord;
  }
  /* /GATEWAY LOGIC /

  /* SHARED UTILS */
  sendToServer(message) {
    sendMessage(this.serverSocket, message);
  }

  flashMessage(message, durationMillis = 1000) {
    this.showMessageBanner = true;
    this.currentMessage = message;

    const messageBanner = this.getMessageBanner();
    messageBanner.classList.remove('fadeOut');
    this.messageBannerHideTimeout = setTimeout(() => {
      messageBanner.classList.add('fadeOut');
      this.messageBannerHideTimeout = setTimeout(() => {
        this.showMessageBanner = false;
      }, parseInt(durationMillis * 0.5, 10));
    }, parseInt(durationMillis * 0.5, 10));
  }
  /* /SHARED UTILS */
}

const playAudio = (audioNode) => {
  audioNode.cloneNode().play();
};

const sendMessage = (socket, message) => {
  socket.send(JSON.stringify(message));
};

const constructMessage = (type, content = {}) => {
  return {
    type,
    ...content
  };
};
