import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity()
export class Ad {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  userId!: number;

  @Column()
  text!: string;

  @Column({ nullable: true })
  photoFileId?: string;

  @Column({ default: 'moderation' }) // moderation, approved, rejected
  status!: string;

  @Column({ nullable: true })
  moderationMessageId?: number; // ID сообщения в группе модерации

  @CreateDateColumn()
  createdAt!: Date;
}