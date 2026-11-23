import {sendRequest} from "./socket";
import { SUMMON_PROMPT_ANSWER_MS, summonPromptReply } from "./summonreplies.ts";

// The server keeps a raid conversion offer open for a minute (social.ts RAID_CONVERT_MS). Unanswered, the popup
// declines it a little before then, as Cancel does, so the answer reaches the server while the offer is still open.
const RAID_CONVERT_MS = 60_000;
const RAID_CONVERT_ANSWER_MS = RAID_CONVERT_MS - 5_000;
let declineAfterMs = RAID_CONVERT_ANSWER_MS;
let raidConvertTimer: ReturnType<typeof setTimeout> | null = null;

function clearRaidConvertTimer() {
  if (raidConvertTimer) clearTimeout(raidConvertTimer);
  raidConvertTimer = null;
}

export function createInvitationPopup(invitationData: any) {

  clearRaidConvertTimer();
  declineAfterMs = RAID_CONVERT_ANSWER_MS;
  const existingPopup = document.getElementById("invitation-popup");
  if (existingPopup) {

    existingPopup.remove();
  }
  const popup = document.createElement("div");
  popup.id = "invitation-popup";
  popup.className = "popup";
  popup.innerHTML = `
    <h2>Invitation</h2>
    <p>${invitationData.message}</p>
    <div class="button-container">
      <button id="accept-invitation">Accept</button>
      <button id="decline-invitation">Decline</button>
    </div>
  `;

  document.body.appendChild(popup);

  const acceptButton = document.getElementById("accept-invitation");
  const declineButton = document.getElementById("decline-invitation");
  let data;
  let declineUnanswered = false;

  switch (invitationData.action.toUpperCase()) {
    case "RAID_CONVERT": {
      const heading = popup.querySelector("h2");
      if (heading) heading.innerText = "Party full";
      if (acceptButton) acceptButton.innerText = "Convert";
      if (declineButton) declineButton.innerText = "Cancel";
      data = {
        type: "INVITATION_RESPONSE",
        data: {
          authorization: invitationData.authorization,
          originator: invitationData.originator,
          action: "RAID_CONVERT",
        },
      }
      declineUnanswered = true;
    }
    break;
    // Accepting brings the summoner's stone's caller here; unanswered it is declined just before the server drops it.
    case "SUMMON_STONE": {
      const heading = popup.querySelector("h2");
      if (heading) heading.innerText = "Summon";
      data = summonPromptReply(invitationData, true);
      declineAfterMs = SUMMON_PROMPT_ANSWER_MS;
      declineUnanswered = true;
    }
    break;
    case "FRIEND_REQUEST": {
      data = {
        type: "INVITATION_RESPONSE",
        data: {
          authorization: invitationData.authorization,
          originator: invitationData.originator,
          action: "FRIEND_REQUEST",
        },
      }
    }
    break;
    case "INVITE_PARTY": {
      data = {
        type: "INVITATION_RESPONSE",
        data: {
          authorization: invitationData.authorization,
          originator: invitationData.originator,
          action: "INVITE_PARTY",
        },
      }
    }
    break;
    case "INVITE_GUILD": {
      data = {
        type: "INVITATION_RESPONSE",
        data: {
          authorization: invitationData.authorization,
          originator: invitationData.originator,
          action: "INVITE_GUILD",
        },
      }
    }
    break;
    // Accepting opens the trade window for both players.
    case "TRADE_REQUEST": {
      const heading = popup.querySelector("h2");
      if (heading) heading.innerText = "Trade Request";
      data = {
        type: "INVITATION_RESPONSE",
        data: {
          authorization: invitationData.authorization,
          originator: invitationData.originator,
          action: "TRADE_REQUEST",
        },
      }
    }
    break;
  }

  if (!data) return;

  const answer = (response: "ACCEPT" | "DECLINE") => {
    clearRaidConvertTimer();
    data.data.response = response;
    sendRequest(data);
    popup.remove();
  };
  acceptButton?.addEventListener("click", () => answer("ACCEPT"));
  declineButton?.addEventListener("click", () => answer("DECLINE"));
  if (declineUnanswered) raidConvertTimer = setTimeout(() => answer("DECLINE"), declineAfterMs);
}

// When the server does not say how long its choice is open.
const DEFAULT_SIZE_CHOICE_MS = 60_000;
let dungeonSizeTimer: ReturnType<typeof setTimeout> | null = null;

function closeDungeonSizePopup() {
  if (dungeonSizeTimer) clearTimeout(dungeonSizeTimer);
  dungeonSizeTimer = null;
  document.getElementById("dungeon-size-popup")?.remove();
}

export function createDungeonSizePopup(choice: any) {
  closeDungeonSizePopup();
  // Open as long as the server keeps the choice open.
  const closeAfterMs = typeof choice.expiresInMs === "number" && choice.expiresInMs > 0 ? choice.expiresInMs : DEFAULT_SIZE_CHOICE_MS;
  const popup = document.createElement("div");
  popup.id = "dungeon-size-popup";
  popup.className = "popup";
  const heading = document.createElement("h2");
  heading.innerText = String(choice.name ?? "Dungeon");
  const text = document.createElement("p");
  text.innerText = "Choose a group size";
  const buttons = document.createElement("div");
  buttons.className = "button-container";
  popup.append(heading, text, buttons);

  for (const size of Array.isArray(choice.sizes) ? choice.sizes : []) {
    const button = document.createElement("button");
    button.innerText = `${size} players`;
    button.addEventListener("click", () => {
      sendRequest({ type: "DUNGEON_SIZE_PICK", data: { authorization: choice.authorization, size } });
      closeDungeonSizePopup();
    });
    buttons.appendChild(button);
  }
  const cancel = document.createElement("button");
  cancel.innerText = "Cancel";
  cancel.addEventListener("click", closeDungeonSizePopup);
  buttons.appendChild(cancel);

  document.body.appendChild(popup);
  dungeonSizeTimer = setTimeout(closeDungeonSizePopup, closeAfterMs);
}
