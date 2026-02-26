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

  @Column({ default: false })
  published!: boolean;

  @CreateDateColumn()
  createdAt!: Date;
}