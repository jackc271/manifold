import * as admin from 'firebase-admin'
import {
  Notification,
  NotificationSourceTypes,
} from '../../common/notification'
import { User } from '../../common/user'
import { Contract } from '../../common/contract'
import { getValues } from './utils'
import { Comment } from '../../common/comment'
import { uniq } from 'lodash'
import { Bet } from '../../common/bet'
import { Answer } from '../../common/answer'
const firestore = admin.firestore()

export const createNotification = async (
  sourceId: string,
  sourceType: typeof NotificationSourceTypes[keyof typeof NotificationSourceTypes],
  sourceContract: Contract,
  sourceUser: User,
  idempotencyKey: string
) => {
  const userAndMessagesMap: { [userId: string]: string } = {}

  const shouldGetNotification = (userId: string) => {
    return (
      sourceUser.id != userId &&
      !Object.keys(userAndMessagesMap).includes(userId)
    )
  }

  const createUsersNotifications = async (userAndMessagesMap: {
    [userId: string]: string
  }) => {
    await Promise.all(
      Object.keys(userAndMessagesMap).map(async (userId) => {
        const notificationRef = firestore
          .collection(`/users/${userId}/notifications`)
          .doc(idempotencyKey)
        const notification: Notification = {
          id: idempotencyKey,
          userId,
          reasonText: userAndMessagesMap[userId],
          createdTime: Date.now(),
          isSeen: false,
          sourceId,
          sourceType,
          sourceContractId: sourceContract.id,
          sourceUserName: sourceUser.name,
          sourceUserUserName: sourceUser.username,
          sourceUserAvatarUrl: sourceUser.avatarUrl,
        }
        await notificationRef.set(notification)
      })
    )
  }

  // TODO: update for liquidity
  // TODO: find tagged users
  if (
    sourceType === NotificationSourceTypes.COMMENT ||
    sourceType === NotificationSourceTypes.ANSWER ||
    sourceType === NotificationSourceTypes.CONTRACT
  ) {
    const reasonTextPretext =
      sourceType === NotificationSourceTypes.COMMENT
        ? 'commented on'
        : sourceType === NotificationSourceTypes.ANSWER
        ? 'submitted a new answer to'
        : 'updated' // NotificationSourceTypes.CONTRACT

    const notifyContractCreator = async () => {
      if (sourceContract.creatorId !== sourceUser.id)
        userAndMessagesMap[
          sourceContract.creatorId
        ] = `${reasonTextPretext} your question`
    }

    const notifyOtherAnswerersOnContract = async () => {
      const answers = await getValues<Answer>(
        firestore
          .collection('contracts')
          .doc(sourceContract.id)
          .collection('answers')
      )
      const recipientUserIds = uniq([
        sourceContract.creatorId,
        ...answers.map((answer) => answer.userId),
      ]).filter((id) => id !== sourceUser.id)
      recipientUserIds.forEach((userId) => {
        if (shouldGetNotification(userId))
          userAndMessagesMap[
            userId
          ] = `${reasonTextPretext} a question you submitted an answer to`
      })
    }

    const notifyOtherCommentersOnContract = async () => {
      const comments = await getValues<Comment>(
        firestore
          .collection('contracts')
          .doc(sourceContract.id)
          .collection('comments')
      )
      const recipientUserIds = uniq([
        sourceContract.creatorId,
        ...comments.map((comment) => comment.userId),
      ]).filter((id) => id !== sourceUser.id)
      recipientUserIds.forEach((userId) => {
        if (shouldGetNotification(userId))
          userAndMessagesMap[
            userId
          ] = `${reasonTextPretext} a question you commented on`
      })
    }

    // Only notifies those who have open bets in the question, we could also notify those who have sold their bets
    const notifyOtherBettorsOnContract = async () => {
      const betsSnap = await firestore
        .collection(`contracts/${sourceContract.id}/bets`)
        .get()
      const bets = betsSnap.docs.map((doc) => doc.data() as Bet)
      const openBets = bets.filter((b) => !b.isSold && !b.sale)
      const recipientUserIds = uniq(openBets.map((bet) => bet.userId))
      recipientUserIds.forEach((userId) => {
        if (shouldGetNotification(userId))
          userAndMessagesMap[
            userId
          ] = `${reasonTextPretext} a question you bet on`
      })
    }

    // The order of these functions determines what notification text is shown to the user
    await notifyContractCreator()
    await notifyOtherAnswerersOnContract()
    await notifyOtherCommentersOnContract()
    await notifyOtherBettorsOnContract()
    await createUsersNotifications(userAndMessagesMap)
  }
}
