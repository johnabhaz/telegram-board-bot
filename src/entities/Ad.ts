import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Category } from './Category';

@Entity()
export class Ad {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  userId!: number;

  @Column()
  text!: string;

  @Column("simple-array", { nullable: true })
  photoFileIds?: string[];

  @Column({ default: 'moderation' })
  status!: string;

  @Column({ nullable: true })
  moderationMessageId?: number;

  @ManyToOne(() => Category, category => category.ads)
  @JoinColumn({ name: 'categoryId' })
  category!: Category;

  @Column({ nullable: true })
  categoryId?: number;

  @CreateDateColumn()
  createdAt!: Date;
}