import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from 'typeorm';
import { Ad } from './Ad';

@Entity()
export class Category {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true })
  name!: string;

  @OneToMany(() => Ad, ad => ad.category)
  ads!: Ad[];
}